import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  SCHEMA_VERSION,
  canonicalJsonString,
  validateEvent,
} from "../contracts.mjs";
import {
  hashCoordinatorState,
  initialCoordinatorState,
  reduceCoordinatorEvent,
  stableStringify,
} from "./reducer.mjs";

const DEFAULT_MAX_SEGMENT_BYTES = 10 * 1024 * 1024;
const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const SEGMENT_PATTERN = /^segment-(\d{6})\.jsonl$/;
const PENDING_PATTERN = /^\.pending-(segment-(\d{6})\.jsonl)$/;
const rootMutationTails = new Map();

function rootMutationKey(rootDir) {
  return path.resolve(rootDir).toLowerCase();
}

async function withRootMutation(rootDir, operation) {
  const key = rootMutationKey(rootDir);
  const previous = rootMutationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  rootMutationTails.set(key, current);
  try {
    return await current;
  } finally {
    if (rootMutationTails.get(key) === current) {
      rootMutationTails.delete(key);
    }
  }
}

function sharedMutationLockPath(rootDir) {
  return path.join(
    path.dirname(path.resolve(rootDir)),
    ".codex-coordinator-upgrade.lock",
  );
}

async function withJournalMutationFence(rootDir, operationName, operation) {
  const lockPath = sharedMutationLockPath(rootDir);
  const token = randomUUID();
  const lockText = `${canonicalJsonString({
    schemaVersion: SCHEMA_VERSION,
    operation: "journal-mutation",
    operationName,
    rootDir: path.resolve(rootDir),
    ownerPid: process.pid,
    token,
    acquiredUtc: new Date().toISOString(),
  }, "journal mutation lock")}\n`;
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(lockText, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    }
    if (error.code === "EEXIST") {
      throw new Error(
        `journal mutation is fenced by an active coordinator lock: ${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  await handle.close();
  const expectedHash = createHash("sha256")
    .update(lockText, "utf8")
    .digest("hex");
  try {
    return await operation();
  } finally {
    const currentHash = createHash("sha256")
      .update(await readFile(lockPath), "utf8")
      .digest("hex");
    if (currentHash !== expectedHash) {
      throw new Error("journal mutation lock identity drifted before release");
    }
    await unlink(lockPath);
  }
}

function segmentName(number) {
  return `segment-${String(number).padStart(6, "0")}.jsonl`;
}

function parseSegmentNumber(fileName) {
  const match = SEGMENT_PATTERN.exec(fileName);
  return match ? Number(match[1]) : null;
}

async function listSegmentPaths(rootDir) {
  const segmentsDir = path.join(rootDir, "journal", "segments");
  let entries;
  try {
    entries = await readdir(segmentsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const paths = [];
  for (const entry of entries
    .filter((item) => SEGMENT_PATTERN.test(item.name))
    .sort((first, second) =>
      first.name < second.name ? -1 : first.name > second.name ? 1 : 0
    )) {
    const segmentPath = path.join(segmentsDir, entry.name);
    const details = await lstat(segmentPath);
    if (
      entry.isSymbolicLink() ||
      details.isSymbolicLink() ||
      !entry.isFile() ||
      !details.isFile() ||
      details.nlink !== 1
    ) {
      throw new Error(
        `journal rejects symbolic, hard-linked, or non-file segment ${entry.name}`,
      );
    }
    paths.push(segmentPath);
  }
  return paths;
}

function parseSegmentText(text, segmentPath, isActive) {
  const hasFinalNewline = text.length === 0 || text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (hasFinalNewline) {
    lines.pop();
  }
  const events = [];
  let tail = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) {
      throw new Error(`journal contains an empty record in ${segmentPath}`);
    }
    const isFinalUnterminatedLine =
      isActive && !hasFinalNewline && index === lines.length - 1;
    if (isFinalUnterminatedLine) {
      tail = {
        path: segmentPath,
        byteLength: Buffer.byteLength(line, "utf8"),
        sha256: createHash("sha256").update(line, "utf8").digest("hex"),
        preview: line.slice(0, 256),
      };
      continue;
    }
    try {
      const event = JSON.parse(line);
      events.push(validateEvent(event));
    } catch (error) {
      throw new Error(
        `journal record is invalid in ${segmentPath}: ${error.message}`,
        { cause: error },
      );
    }
  }
  return { events, tail };
}

async function scanJournal(rootDir) {
  await assertSafeExistingPath(rootDir, "directory", "journal root");
  await assertSafeExistingPath(
    path.join(rootDir, "journal"),
    "directory",
    "journal metadata directory",
  );
  await assertSafeExistingPath(
    path.join(rootDir, "journal", "segments"),
    "directory",
    "journal segments directory",
  );
  const segmentPaths = await listSegmentPaths(rootDir);
  const events = [];
  let tail = null;
  for (let index = 0; index < segmentPaths.length; index += 1) {
    const segmentPath = segmentPaths[index];
    const parsed = parseSegmentText(
      await readFile(segmentPath, "utf8"),
      segmentPath,
      index === segmentPaths.length - 1,
    );
    if (
      index > 0 &&
      parsed.events.at(0)?.type !== "state.checkpoint"
    ) {
      throw new Error(
        `rotated journal segment must begin with a checkpoint: ${segmentPath}`,
      );
    }
    events.push(...parsed.events);
    tail = parsed.tail ?? tail;
  }

  for (let index = 1; index < events.length; index += 1) {
    const expected = events[index - 1].sequence + 1;
    if (events[index].sequence !== expected) {
      throw new Error(
        `journal sequence discontinuity: expected ${expected}, received ${events[index].sequence}`,
      );
    }
  }
  if (events.length > 0 && events[0].sequence !== 1) {
    const first = events[0];
    const isCheckpointAnchor =
      first.type === "state.checkpoint" &&
      first.payload.priorLastSequence === first.sequence - 1;
    if (!isCheckpointAnchor) {
      throw new Error(
        `journal genesis sequence must be 1 or a verified checkpoint anchor, received ${first.sequence}`,
      );
    }
  }
  let verifiedState = initialCoordinatorState();
  for (const event of events) {
    if (
      event.type === "state.checkpoint" &&
      verifiedState.lastSequence > 0 &&
      (event.payload.priorLastSequence !== verifiedState.lastSequence ||
        event.payload.stateHash !== hashCoordinatorState(verifiedState))
    ) {
      throw new Error(
        "journal checkpoint does not match authoritative retained history",
      );
    }
    verifiedState = reduceCoordinatorEvent(verifiedState, event);
  }

  return {
    events,
    tail,
    segmentPaths,
    activePath: segmentPaths.at(-1) ?? null,
  };
}

async function writeFlushedFile(filePath, text, flag = "wx") {
  const handle = await open(filePath, flag);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFlushedFile(
      temporaryPath,
      `${canonicalJsonString(value, "journal metadata")}\n`,
    );
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function listPendingCheckpoints(segmentsDir) {
  const entries = await readdir(segmentsDir, { withFileTypes: true });
  const pending = [];
  for (const entry of entries
    .filter((item) => PENDING_PATTERN.test(item.name))
    .sort((first, second) =>
      first.name < second.name ? -1 : first.name > second.name ? 1 : 0
    )) {
    const pendingPath = path.join(segmentsDir, entry.name);
    const details = await lstat(pendingPath);
    if (
      entry.isSymbolicLink() ||
      details.isSymbolicLink() ||
      !entry.isFile() ||
      !details.isFile() ||
      details.nlink !== 1
    ) {
      throw new Error(
        `journal rejects symbolic or non-file checkpoint ${entry.name}`,
      );
    }
    pending.push(pendingPath);
  }
  return pending;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertSafeExistingPath(filePath, expectedKind, label) {
  let details;
  try {
    details = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (details.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link or reparse path`);
  }
  if (
    (expectedKind === "directory" && !details.isDirectory()) ||
    (expectedKind === "file" && !details.isFile())
  ) {
    throw new Error(`${label} must be a ${expectedKind}`);
  }
  if (expectedKind === "file" && details.nlink !== 1) {
    throw new Error(`${label} cannot have multiple hard links`);
  }
  return true;
}

async function readRetention(journalDir) {
  const retentionPath = path.join(journalDir, "retention.json");
  try {
    await assertSafeExistingPath(
      retentionPath,
      "file",
      "journal retention metadata",
    );
    const retention = JSON.parse(await readFile(retentionPath, "utf8"));
    return validateRetention(retention);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schemaVersion: SCHEMA_VERSION,
        eligibleSegments: [],
      };
    }
    throw new Error(`retention metadata is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

function validateRetention(retention) {
  if (
    retention === null ||
    typeof retention !== "object" ||
    Array.isArray(retention) ||
    retention.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(retention.eligibleSegments) ||
    Object.keys(retention).some(
      (key) => !["schemaVersion", "eligibleSegments"].includes(key),
    )
  ) {
    throw new Error("retention schema is invalid");
  }
  const seen = new Set();
  for (const item of retention.eligibleSegments) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) =>
          ![
            "path",
            "eligibleUtc",
            "deleteAfterUtc",
            "checkpointSequence",
            "stateHash",
          ].includes(key),
      ) ||
      typeof item.path !== "string" ||
      !SEGMENT_PATTERN.test(item.path) ||
      typeof item.eligibleUtc !== "string" ||
      !Number.isFinite(Date.parse(item.eligibleUtc)) ||
      typeof item.deleteAfterUtc !== "string" ||
      !Number.isFinite(Date.parse(item.deleteAfterUtc)) ||
      Date.parse(item.deleteAfterUtc) - Date.parse(item.eligibleUtc) !==
        RETENTION_MILLISECONDS ||
      !Number.isSafeInteger(item.checkpointSequence) ||
      item.checkpointSequence < 1 ||
      typeof item.stateHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.stateHash) ||
      seen.has(item.path)
    ) {
      throw new Error("retention entry schema is invalid");
    }
    seen.add(item.path);
  }
  return retention;
}

async function readRotationState(journalDir) {
  const rotationPath = path.join(journalDir, "rotation-state.json");
  try {
    await assertSafeExistingPath(
      rotationPath,
      "file",
      "journal rotation metadata",
    );
    const rotation = JSON.parse(await readFile(rotationPath, "utf8"));
    if (
      rotation === null ||
      typeof rotation !== "object" ||
      Array.isArray(rotation) ||
      rotation.schemaVersion !== SCHEMA_VERSION ||
      !["prepared", "segment-committed", "complete"].includes(rotation.phase) ||
      typeof rotation.pendingPath !== "string" ||
      typeof rotation.targetPath !== "string" ||
      typeof rotation.previousActivePath !== "string" ||
      !Number.isSafeInteger(rotation.checkpointSequence) ||
      typeof rotation.stateHash !== "string" ||
      rotation.retention === null ||
      typeof rotation.retention !== "object"
    ) {
      throw new Error("rotation state schema is invalid");
    }
    return rotation;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`rotation state is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

async function readJournalMutationFence(rootDir) {
  const lockPath = sharedMutationLockPath(rootDir);
  if (!(await assertSafeExistingPath(
    lockPath,
    "file",
    "shared coordinator mutation lock",
  ))) {
    return null;
  }
  const lockText = await readFile(lockPath, "utf8");
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch (error) {
    throw new Error("shared coordinator mutation lock is invalid JSON", {
      cause: error,
    });
  }
  if (
    lock === null ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    lock.operation !== "journal-mutation"
  ) {
    return null;
  }
  const expectedKeys = [
    "acquiredUtc",
    "operation",
    "operationName",
    "ownerPid",
    "rootDir",
    "schemaVersion",
    "token",
  ];
  if (
    Object.keys(lock).length !== expectedKeys.length ||
    Object.keys(lock).some((key) => !expectedKeys.includes(key)) ||
    lock.schemaVersion !== SCHEMA_VERSION ||
    !["append", "checkpoint", "rotate"].includes(lock.operationName) ||
    !Number.isSafeInteger(lock.ownerPid) ||
    lock.ownerPid < 1 ||
    typeof lock.token !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(lock.token) ||
    typeof lock.acquiredUtc !== "string" ||
    !Number.isFinite(Date.parse(lock.acquiredUtc)) ||
    typeof lock.rootDir !== "string" ||
    path.resolve(lock.rootDir).toLowerCase() !==
      path.resolve(rootDir).toLowerCase()
  ) {
    throw new Error(
      "shared coordinator journal mutation lock schema or ownership is invalid",
    );
  }
  return {
    kind: "journal-mutation",
    operationName: lock.operationName,
    ownerPid: lock.ownerPid,
    acquiredUtc: lock.acquiredUtc,
    rootDir: lock.rootDir,
    token: lock.token,
    lockPath,
    lockSha256: createHash("sha256")
      .update(lockText, "utf8")
      .digest("hex"),
  };
}

async function validateCompletedRotation(
  rotation,
  segmentsDir,
  activePath,
) {
  const targetName = path.basename(rotation.targetPath);
  const previousName = path.basename(rotation.previousActivePath);
  const previousNumber = parseSegmentNumber(previousName);
  const targetNumber = parseSegmentNumber(targetName);
  if (
    path.dirname(rotation.targetPath) !== segmentsDir ||
    path.dirname(rotation.pendingPath) !== segmentsDir ||
    path.dirname(rotation.previousActivePath) !== segmentsDir ||
    rotation.pendingPath !==
      path.join(segmentsDir, `.pending-${targetName}`) ||
    previousNumber === null ||
    targetNumber !== previousNumber + 1 ||
    rotation.targetPath !== activePath
  ) {
    throw new Error("completed rotation ledger identity is invalid");
  }
  await assertSafeExistingPath(
    rotation.targetPath,
    "file",
    "completed rotation target",
  );
  await assertSafeExistingPath(
    rotation.previousActivePath,
    "file",
    "completed rotation retained segment",
  );
  if (await fileExists(rotation.pendingPath)) {
    throw new Error("completed rotation still has a pending checkpoint");
  }
  const parsed = parseSegmentText(
    await readFile(rotation.targetPath, "utf8"),
    rotation.targetPath,
    true,
  );
  const checkpointEvent = parsed.events.at(0);
  const retention = validateRetention(rotation.retention);
  const persistedRetention = await readRetention(path.dirname(segmentsDir));
  if (
    canonicalJsonString(persistedRetention, "journal retention metadata") !==
    canonicalJsonString(retention, "completed rotation retention")
  ) {
    throw new Error(
      "journal retention metadata drifted from the completed rotation ledger",
    );
  }
  for (const item of retention.eligibleSegments) {
    if (
      Date.parse(item.deleteAfterUtc) > Date.now() &&
      !(await assertSafeExistingPath(
        path.join(segmentsDir, item.path),
        "file",
        "unexpired retained journal segment",
      ))
    ) {
      throw new Error(
        `unexpired retained journal segment is missing: ${item.path}`,
      );
    }
  }
  const retained = retention.eligibleSegments.find(
    (item) => item.path === previousName,
  );
  if (
    checkpointEvent?.type !== "state.checkpoint" ||
    checkpointEvent.sequence !== rotation.checkpointSequence ||
    checkpointEvent.payload.stateHash !== rotation.stateHash ||
    checkpointEvent.payload.priorSegment !== previousName ||
    !retained ||
    retained.checkpointSequence !== rotation.checkpointSequence ||
    retained.stateHash !== rotation.stateHash
  ) {
    throw new Error(
      "completed rotation ledger does not match its checkpoint and retention boundary",
    );
  }
}

async function inspectRecoveryStatus(rootDir) {
  const journalDir = path.join(rootDir, "journal");
  const segmentsDir = path.join(journalDir, "segments");
  const current = await scanJournal(rootDir);
  let pendingCheckpoints = [];
  try {
    pendingCheckpoints = await listPendingCheckpoints(segmentsDir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const rotation = await readRotationState(journalDir);
  const mutationFence = await readJournalMutationFence(rootDir);
  if (rotation?.phase === "complete") {
    await validateCompletedRotation(
      rotation,
      segmentsDir,
      current.activePath,
    );
  }
  if (
    current.tail ||
    pendingCheckpoints.length > 0 ||
    (rotation && rotation.phase !== "complete") ||
    mutationFence
  ) {
    return {
      health: "recovery-required",
      tail: current.tail,
      pendingCheckpoints,
      rotation,
      mutationFence,
    };
  }
  return {
    health: "healthy",
    tail: null,
    pendingCheckpoints,
    rotation,
    mutationFence: null,
  };
}

function addRetentionEligibility(
  retention,
  previousActivePath,
  checkpointEvent,
) {
  const now = new Date();
  const previousName = path.basename(previousActivePath);
  const next = structuredClone(retention);
  next.eligibleSegments = next.eligibleSegments.filter(
    (item) => item.path !== previousName,
  );
  next.eligibleSegments.push({
    path: previousName,
    eligibleUtc: now.toISOString(),
    deleteAfterUtc: new Date(
      now.getTime() + RETENTION_MILLISECONDS,
    ).toISOString(),
    checkpointSequence: checkpointEvent.sequence,
    stateHash: checkpointEvent.payload.stateHash,
  });
  return next;
}

async function pruneExpiredRetention(retention, segmentsDir, preservedPaths) {
  const preservedNames = new Set(
    preservedPaths.map((item) => path.basename(item)),
  );
  const retained = [];
  for (const item of retention.eligibleSegments) {
    if (
      Date.parse(item.deleteAfterUtc) > Date.now() ||
      preservedNames.has(item.path)
    ) {
      retained.push(item);
      continue;
    }
    const expiredPath = path.join(segmentsDir, item.path);
    try {
      await unlink(expiredPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    eligibleSegments: retained,
  };
}

async function loadPendingCheckpoint(pendingPath) {
  await assertSafeExistingPath(
    pendingPath,
    "file",
    "journal checkpoint",
  );
  const text = await readFile(pendingPath, "utf8");
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length !== 1 || !text.endsWith("\n")) {
    throw new Error("checkpoint pending segment must contain one complete event");
  }
  let event;
  try {
    event = JSON.parse(lines[0]);
    event = validateEvent(event);
  } catch (error) {
    throw new Error(`checkpoint event is invalid: ${error.message}`, {
      cause: error,
    });
  }
  if (event.type !== "state.checkpoint") {
    throw new Error("checkpoint pending segment must start with state.checkpoint");
  }
  return event;
}

export async function readJournalEvents(rootDir) {
  return (await scanJournal(rootDir)).events;
}

export async function readJournalRecoveryStatus(rootDir) {
  return withRootMutation(rootDir, () => inspectRecoveryStatus(rootDir));
}

export async function recoverJournalMutationFence(
  rootDir,
  { expectedLockSha256 } = {},
) {
  if (
    typeof expectedLockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(expectedLockSha256)
  ) {
    throw new TypeError(
      "journal mutation recovery requires an expected lock SHA-256",
    );
  }
  return withRootMutation(rootDir, async () => {
    const mutationFence = await readJournalMutationFence(rootDir);
    if (!mutationFence) {
      throw new Error("no journal mutation fence is available for recovery");
    }
    if (mutationFence.lockSha256 !== expectedLockSha256.toLowerCase()) {
      throw new Error("journal mutation recovery lock hash drifted");
    }
    let ownerIsAlive = true;
    try {
      process.kill(mutationFence.ownerPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        ownerIsAlive = false;
      }
    }
    if (ownerIsAlive) {
      throw new Error(
        `journal mutation recovery refuses live owner PID ${mutationFence.ownerPid}`,
      );
    }
    await assertSafeExistingPath(
      mutationFence.lockPath,
      "file",
      "journal mutation recovery lock",
    );
    const currentHash = createHash("sha256")
      .update(await readFile(mutationFence.lockPath), "utf8")
      .digest("hex");
    if (currentHash !== expectedLockSha256.toLowerCase()) {
      throw new Error(
        "journal mutation recovery lock hash drifted before release",
      );
    }
    await unlink(mutationFence.lockPath);
    return inspectRecoveryStatus(rootDir);
  });
}

export async function openJournal({
  rootDir,
  maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
  boundaryHook = () => {},
}) {
  if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1) {
    throw new RangeError("maximum journal segment bytes must be positive");
  }

  const journalDir = path.join(rootDir, "journal");
  const segmentsDir = path.join(journalDir, "segments");
  let scan = await withRootMutation(rootDir, async () => {
    await assertSafeExistingPath(rootDir, "directory", "journal root");
    await assertSafeExistingPath(
      journalDir,
      "directory",
      "journal metadata directory",
    );
    await assertSafeExistingPath(
      segmentsDir,
      "directory",
      "journal segments directory",
    );
    await mkdir(segmentsDir, { recursive: true });
    await assertSafeExistingPath(rootDir, "directory", "journal root");
    await assertSafeExistingPath(
      journalDir,
      "directory",
      "journal metadata directory",
    );
    await assertSafeExistingPath(
      segmentsDir,
      "directory",
      "journal segments directory",
    );
    let initialScan = await scanJournal(rootDir);
    if (initialScan.segmentPaths.length === 0) {
      const firstPath = path.join(segmentsDir, segmentName(1));
      try {
        await writeFlushedFile(firstPath, "");
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
      initialScan = await scanJournal(rootDir);
    }
    return initialScan;
  });
  let currentActivePath = scan.activePath;

  async function refreshUnlocked() {
    scan = await scanJournal(rootDir);
    currentActivePath = scan.activePath;
    return scan;
  }

  async function mutate(operationName, operation) {
    return withRootMutation(rootDir, () =>
      withJournalMutationFence(rootDir, operationName, operation));
  }

  async function append(event, { flush = false } = {}) {
    return mutate("append", async () => {
      const current = await refreshUnlocked();
      const pendingCheckpoints = await listPendingCheckpoints(segmentsDir);
      const rotation = await readRotationState(journalDir);
      if (rotation?.phase === "complete") {
        await validateCompletedRotation(
          rotation,
          segmentsDir,
          current.activePath,
        );
      }
      if (
        current.tail ||
        pendingCheckpoints.length > 0 ||
        (rotation && rotation.phase !== "complete")
      ) {
        throw new Error(
          "journal is recovery-required because a tail, checkpoint, or rotation is unresolved",
        );
      }
      const expectedSequence = (current.events.at(-1)?.sequence ?? 0) + 1;
      const validatedEvent = validateEvent(event);
      if (validatedEvent.type === "state.checkpoint") {
        throw new Error(
          "checkpoint events cannot be appended outside the checkpoint workflow",
        );
      }
      if (validatedEvent.sequence !== expectedSequence) {
        throw new RangeError(
          `journal sequence must be ${expectedSequence}, received ${validatedEvent.sequence}`,
        );
      }

      await boundaryHook("append.before", {
        event: validatedEvent,
        activePath: currentActivePath,
      });
      const expectedIdentity = await lstat(currentActivePath);
      if (
        expectedIdentity.isSymbolicLink() ||
        !expectedIdentity.isFile() ||
        expectedIdentity.nlink !== 1
      ) {
        throw new Error(
          "journal active segment identity is symbolic, linked, or invalid",
        );
      }
      const handle = await open(currentActivePath, "a");
      try {
        const openedIdentity = await handle.stat();
        if (
          !openedIdentity.isFile() ||
          openedIdentity.nlink !== 1 ||
          openedIdentity.dev !== expectedIdentity.dev ||
          openedIdentity.ino !== expectedIdentity.ino
        ) {
          throw new Error(
            "journal active segment identity changed before append",
          );
        }
        await handle.writeFile(`${stableStringify(validatedEvent)}\n`, "utf8");
        await boundaryHook("append.after", {
          event: validatedEvent,
          activePath: currentActivePath,
        });
        if (flush) {
          await boundaryHook("flush.before", {
            event: validatedEvent,
            activePath: currentActivePath,
          });
          await handle.sync();
          await boundaryHook("flush.after", {
            event: validatedEvent,
            activePath: currentActivePath,
          });
        }
      } finally {
        await handle.close();
      }
      await refreshUnlocked();
      return validatedEvent;
    });
  }

  async function readFrom(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError("journal read sequence must be non-negative");
    }
    return withRootMutation(rootDir, async () => {
      const current = await refreshUnlocked();
      return current.events.filter((event) => event.sequence > sequence);
    });
  }

  async function checkpoint(state) {
    return mutate("checkpoint", async () => {
      const current = await refreshUnlocked();
      if (current.tail) {
        throw new Error("cannot checkpoint a journal with a truncated tail");
      }
      const pendingPaths = await listPendingCheckpoints(segmentsDir);
      const rotation = await readRotationState(journalDir);
      if (rotation?.phase === "complete") {
        await validateCompletedRotation(
          rotation,
          segmentsDir,
          current.activePath,
        );
      }
      if (
        pendingPaths.length > 0 ||
        (rotation && rotation.phase !== "complete")
      ) {
        throw new Error("an unresolved checkpoint or rotation already exists");
      }
      const lastSequence = current.events.at(-1)?.sequence ?? 0;
      if (state.lastSequence !== lastSequence) {
        throw new Error(
          `checkpoint state sequence ${state.lastSequence} does not match journal ${lastSequence}`,
        );
      }
      const authoritativeState = current.events.reduce(
        (currentState, item) =>
          reduceCoordinatorEvent(currentState, item),
        initialCoordinatorState(),
      );
      const authoritativeHash = hashCoordinatorState(authoritativeState);
      const suppliedHash = hashCoordinatorState(state);
      if (authoritativeHash !== suppliedHash) {
        throw new Error(
          "checkpoint state hash does not match authoritative journal replay",
        );
      }
      await boundaryHook("checkpoint.before", {
        activePath: currentActivePath,
        state,
      });
      const nextNumber =
        (parseSegmentNumber(path.basename(currentActivePath)) ?? 0) + 1;
      const targetName = segmentName(nextNumber);
      const pendingPath = path.join(segmentsDir, `.pending-${targetName}`);
      const checkpointEvent = validateEvent({
        schemaVersion: SCHEMA_VERSION,
        sequence: lastSequence + 1,
        eventId: randomUUID(),
        timestampUtc: new Date().toISOString(),
        source: "core.journal",
        type: "state.checkpoint",
        payload: {
          state: structuredClone(authoritativeState),
          stateHash: authoritativeHash,
          priorLastSequence: lastSequence,
          priorSegment: path.basename(currentActivePath),
        },
      });
      await writeFlushedFile(
        pendingPath,
        `${stableStringify(checkpointEvent)}\n`,
      );
      await boundaryHook("checkpoint.after", {
        activePath: currentActivePath,
        pendingPath,
        checkpointEvent,
      });
      return {
        pendingPath,
        targetPath: path.join(segmentsDir, targetName),
        stateHash: authoritativeHash,
        checkpointSequence: checkpointEvent.sequence,
      };
    });
  }

  async function rotate() {
    return mutate("rotate", async () => {
      const rotationPath = path.join(journalDir, "rotation-state.json");
      const initialCurrent = await refreshUnlocked();

      async function completeCommittedRotation(rotation) {
        if (!(await fileExists(rotation.targetPath))) {
          throw new Error("rotation target is missing during recovery");
        }
        const prunedRetention = await pruneExpiredRetention(
          rotation.retention,
          segmentsDir,
          [rotation.targetPath, rotation.previousActivePath],
        );
        await writeAtomicJson(
          path.join(journalDir, "retention.json"),
          prunedRetention,
        );
        const completed = {
          ...rotation,
          retention: prunedRetention,
          phase: "complete",
          completedUtc: new Date().toISOString(),
        };
        await writeAtomicJson(rotationPath, completed);
        await refreshUnlocked();
        return {
          activePath: rotation.targetPath,
          previousActivePath: rotation.previousActivePath,
          checkpointSequence: rotation.checkpointSequence,
          stateHash: rotation.stateHash,
        };
      }

      let rotation = await readRotationState(journalDir);
      if (rotation?.phase === "complete") {
        await validateCompletedRotation(
          rotation,
          segmentsDir,
          initialCurrent.activePath,
        );
      }
      if (rotation && rotation.phase !== "complete") {
        const targetExists = await fileExists(rotation.targetPath);
        const pendingExists = await fileExists(rotation.pendingPath);
        const targetName = path.basename(rotation.targetPath);
        const previousNumber = parseSegmentNumber(
          path.basename(rotation.previousActivePath),
        );
        const targetNumber = parseSegmentNumber(targetName);
        if (
          path.dirname(rotation.targetPath) !== segmentsDir ||
          path.dirname(rotation.pendingPath) !== segmentsDir ||
          path.dirname(rotation.previousActivePath) !== segmentsDir ||
          rotation.pendingPath !==
            path.join(segmentsDir, `.pending-${targetName}`) ||
          previousNumber === null ||
          targetNumber !== previousNumber + 1 ||
          rotation.targetPath === rotation.previousActivePath
        ) {
          throw new Error("rotation ledger identity is invalid");
        }
        const checkpointPath = targetExists
          ? rotation.targetPath
          : rotation.pendingPath;
        const checkpointEvent = await loadPendingCheckpoint(checkpointPath);
        const retention = validateRetention(rotation.retention);
        const retained = retention.eligibleSegments.find(
          (item) => item.path === path.basename(rotation.previousActivePath),
        );
        if (
          checkpointEvent.sequence !== rotation.checkpointSequence ||
          checkpointEvent.payload.stateHash !== rotation.stateHash ||
          checkpointEvent.payload.priorSegment !==
            path.basename(rotation.previousActivePath) ||
          !retained ||
          retained.checkpointSequence !== rotation.checkpointSequence ||
          retained.stateHash !== rotation.stateHash
        ) {
          throw new Error(
            "rotation ledger does not match its checkpoint and retention boundary",
          );
        }
        if (
          rotation.phase === "segment-committed" ||
          (rotation.phase === "prepared" && targetExists && !pendingExists)
        ) {
          if (rotation.phase === "prepared") {
            rotation = {
              ...rotation,
              phase: "segment-committed",
              segmentCommittedUtc: new Date().toISOString(),
            };
            await writeAtomicJson(rotationPath, rotation);
          }
          return completeCommittedRotation(rotation);
        }
        if (!pendingExists || targetExists) {
          throw new Error("rotation recovery state is ambiguous");
        }
      }

      const pendingPaths = await listPendingCheckpoints(segmentsDir);
      if (pendingPaths.length !== 1) {
        throw new Error("rotation requires exactly one verified checkpoint");
      }
      const pendingPath = pendingPaths[0];
      const checkpointEvent = await loadPendingCheckpoint(pendingPath);
      const current = await refreshUnlocked();
      if (current.tail) {
        throw new Error("cannot rotate a journal with a truncated tail");
      }
      const priorLastSequence = current.events.at(-1)?.sequence ?? 0;
      if (checkpointEvent.sequence !== priorLastSequence + 1) {
        throw new Error(
          `checkpoint sequence must be ${priorLastSequence + 1}, received ${checkpointEvent.sequence}`,
        );
      }
      if (
        checkpointEvent.payload.priorLastSequence !== priorLastSequence
      ) {
        throw new Error("checkpoint sequence boundary drifted before rotation");
      }
      if (
        checkpointEvent.payload.priorSegment !==
        path.basename(currentActivePath)
      ) {
        throw new Error("checkpoint segment boundary drifted before rotation");
      }
      const authoritativeState = current.events.reduce(
        (currentState, item) =>
          reduceCoordinatorEvent(currentState, item),
        initialCoordinatorState(),
      );
      if (
        hashCoordinatorState(authoritativeState) !==
        checkpointEvent.payload.stateHash
      ) {
        throw new Error(
          "checkpoint state hash no longer matches authoritative replay",
        );
      }
      const restored = reduceCoordinatorEvent(
        initialCoordinatorState(),
        checkpointEvent,
      );
      if (
        hashCoordinatorState(restored) !== checkpointEvent.payload.stateHash
      ) {
        throw new Error("checkpoint replay state hash does not match");
      }
      const pendingName = path.basename(pendingPath);
      const match = PENDING_PATTERN.exec(pendingName);
      const targetPath = path.join(segmentsDir, match[1]);
      const previousActivePath = currentActivePath;
      const retention = addRetentionEligibility(
        await readRetention(journalDir),
        previousActivePath,
        checkpointEvent,
      );
      rotation = {
        schemaVersion: SCHEMA_VERSION,
        phase: "prepared",
        pendingPath,
        targetPath,
        previousActivePath,
        checkpointSequence: checkpointEvent.sequence,
        stateHash: checkpointEvent.payload.stateHash,
        retention,
        preparedUtc: new Date().toISOString(),
      };
      await writeAtomicJson(rotationPath, rotation);

      await boundaryHook("rotation.before", {
        pendingPath,
        targetPath,
        previousActivePath,
      });
      await rename(pendingPath, targetPath);
      currentActivePath = targetPath;
      await boundaryHook("rotation.after", {
        targetPath,
        previousActivePath,
      });
      rotation = {
        ...rotation,
        phase: "segment-committed",
        segmentCommittedUtc: new Date().toISOString(),
      };
      await writeAtomicJson(rotationPath, rotation);
      return completeCommittedRotation(rotation);
    });
  }

  async function getRecoveryStatus() {
    return withRootMutation(rootDir, () => inspectRecoveryStatus(rootDir));
  }

  async function needsRotation() {
    return withRootMutation(rootDir, async () => {
      await refreshUnlocked();
      return (await stat(currentActivePath)).size >= maxSegmentBytes;
    });
  }

  return {
    get activePath() {
      return currentActivePath;
    },
    rootDir,
    maxSegmentBytes,
    append,
    readFrom,
    checkpoint,
    rotate,
    getRecoveryStatus,
    needsRotation,
  };
}
