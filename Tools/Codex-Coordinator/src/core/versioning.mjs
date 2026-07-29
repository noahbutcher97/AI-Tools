import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  SCHEMA_VERSION,
  canonicalJsonString,
} from "../contracts.mjs";
import {
  readJournalEvents,
  readJournalRecoveryStatus,
} from "./journal.mjs";
import {
  hashCoordinatorState,
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "./reducer.mjs";

function parseVersion(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a semantic version`);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new TypeError(`${label} must be a semantic version`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(first, second) {
  for (let index = 0; index < 3; index += 1) {
    if (first[index] !== second[index]) {
      return first[index] - second[index];
    }
  }
  return 0;
}

async function fileSha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function buildManifest(rootDir, current = rootDir) {
  const entries = await readdir(current, { withFileTypes: true });
  const manifest = [];
  for (const entry of entries.sort((first, second) =>
    first.name < second.name ? -1 : first.name > second.name ? 1 : 0
  )) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path
      .relative(rootDir, absolutePath)
      .replaceAll("\\", "/");
    const details = await lstat(absolutePath);
    if (entry.isSymbolicLink() || details.isSymbolicLink()) {
      throw new Error(`runtime manifest rejects symbolic link ${relativePath}`);
    }
    if (entry.isDirectory() && details.isDirectory()) {
      manifest.push(...(await buildManifest(rootDir, absolutePath)));
    } else if (entry.isFile() && details.isFile()) {
      manifest.push({
        path: relativePath,
        byteLength: details.size,
        sha256: await fileSha256(absolutePath),
      });
    } else {
      throw new Error(
        `runtime manifest rejects unsupported file type ${relativePath}`,
      );
    }
  }
  return manifest;
}

function manifestHash(manifest) {
  return createHash("sha256")
    .update(canonicalJsonString(manifest, "runtime manifest"), "utf8")
    .digest("hex");
}

async function replayState(rootDir) {
  return (await readJournalEvents(rootDir)).reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
}

async function readRuntimeMetadata(rootDir) {
  await assertSafeControlFile(
    path.join(rootDir, "runtime-version.json"),
    "runtime version metadata",
  );
  const metadata = JSON.parse(
    await readFile(path.join(rootDir, "runtime-version.json"), "utf8"),
  );
  if (!Number.isInteger(metadata.schemaVersion)) {
    throw new Error("runtime metadata schema is invalid");
  }
  if (metadata.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `runtime uses newer schema ${metadata.schemaVersion}; supported schema is ${SCHEMA_VERSION}`,
    );
  }
  if (metadata.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `runtime schema ${metadata.schemaVersion} has no ordered migration`,
    );
  }
  parseVersion(metadata.toolVersion, "source tool version");
  if (
    !Number.isSafeInteger(metadata.mutationSequence) ||
    metadata.mutationSequence < 0
  ) {
    throw new Error("runtime mutation sequence is invalid");
  }
  return metadata;
}

async function writeFlushedFile(filePath, text) {
  const handle = await open(filePath, "wx");
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
      `${canonicalJsonString(value, "upgrade metadata")}\n`,
    );
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function sameManifest(first, second) {
  return (
    canonicalJsonString(first, "first runtime manifest") ===
    canonicalJsonString(second, "second runtime manifest")
  );
}

export async function planRuntimeUpgrade({ sourceRoot, targetVersion }) {
  const sourcePath = path.resolve(sourceRoot);
  const sourceDetails = await lstat(sourcePath);
  if (!sourceDetails.isDirectory()) {
    throw new Error("upgrade source root must be a directory");
  }
  const sourceRecovery = await readJournalRecoveryStatus(sourcePath);
  if (sourceRecovery.health !== "healthy") {
    throw new Error(
      "upgrade source journal is recovery-required and must be healthy before planning",
    );
  }
  const metadata = await readRuntimeMetadata(sourcePath);
  const sourceVersion = parseVersion(metadata.toolVersion, "source tool version");
  const target = parseVersion(targetVersion, "target tool version");
  if (compareVersions(target, sourceVersion) <= 0) {
    throw new Error("target tool version must be newer than the source version");
  }

  const sourceManifest = await buildManifest(sourcePath);
  const sourceManifestHash = manifestHash(sourceManifest);
  const sourceState = await replayState(sourcePath);
  const sourceStateHash = hashCoordinatorState(sourceState);
  const sourceBytes = sourceManifest.reduce(
    (total, item) => total + item.byteLength,
    0,
  );
  const requiredBytes = sourceBytes * 3 + 1024 * 1024;
  const storage = await statfs(sourcePath, { bigint: true });
  const availableBytes = Number(storage.bavail * storage.bsize);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `upgrade requires ${requiredBytes} bytes but only ${availableBytes} are available`,
    );
  }

  const parent = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath);
  const planId = createHash("sha256")
    .update(
      `${sourcePath}\0${targetVersion}\0${sourceManifestHash}\0${sourceStateHash}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);

  return {
    dryRun: true,
    planId,
    sourceRoot: sourcePath,
    sourceVersion: metadata.toolVersion,
    targetVersion,
    sourceSchemaVersion: metadata.schemaVersion,
    sourceMutationSequence: metadata.mutationSequence,
    sourceManifest,
    sourceManifestHash,
    sourceStateHash,
    targetSchemaVersion: SCHEMA_VERSION,
    orderedMigrations: [],
    requiredBytes,
    availableBytes,
    backupRoot: path.join(
      parent,
      `${baseName}.backup-${metadata.toolVersion}-${planId}`,
    ),
    targetRoot: path.join(
      parent,
      `${baseName}.upgrade-${targetVersion}-${planId}`,
    ),
    activePointerPath: path.join(parent, "active-root.json"),
    backupPendingRoot: path.join(
      parent,
      `.${baseName}.backup-${metadata.toolVersion}-${planId}.pending`,
    ),
    targetPendingRoot: path.join(
      parent,
      `.${baseName}.upgrade-${targetVersion}-${planId}.pending`,
    ),
    transactionPath: path.join(parent, `.upgrade-${planId}.json`),
    lockPath: path.join(parent, ".codex-coordinator-upgrade.lock"),
  };
}

async function pathExists(value) {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertSafeControlFile(filePath, label) {
  const details = await lstat(filePath);
  if (
    details.isSymbolicLink() ||
    !details.isFile() ||
    details.nlink !== 1
  ) {
    throw new Error(
      `${label} must be a single-link regular file, not a symbolic or hard link`,
    );
  }
}

function isFullyQualifiedWindowsPath(value) {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    /^(?:\\\\|\/\/)(?![?.](?:[\\/]|$))[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(
      value,
    )
  );
}

async function assertActiveRoot(
  pointerPath,
  expectedRoot,
  { allowMissing = false } = {},
) {
  try {
    await assertSafeControlFile(pointerPath, "active root pointer");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    const allowedKeys = new Set([
      "schemaVersion",
      "activeRoot",
      "priorRoot",
      "planId",
      "rolledBackUtc",
      "switchedUtc",
    ]);
    if (
      pointer === null ||
      typeof pointer !== "object" ||
      Array.isArray(pointer) ||
      pointer.schemaVersion !== SCHEMA_VERSION ||
      typeof pointer.activeRoot !== "string" ||
      !isFullyQualifiedWindowsPath(pointer.activeRoot) ||
      Object.keys(pointer).some((key) => !allowedKeys.has(key)) ||
      (Object.hasOwn(pointer, "priorRoot") &&
        (typeof pointer.priorRoot !== "string" ||
          !isFullyQualifiedWindowsPath(pointer.priorRoot))) ||
      (Object.hasOwn(pointer, "planId") && typeof pointer.planId !== "string") ||
      (Object.hasOwn(pointer, "rolledBackUtc") &&
        typeof pointer.rolledBackUtc !== "string") ||
      (Object.hasOwn(pointer, "switchedUtc") &&
        typeof pointer.switchedUtc !== "string")
    ) {
      throw new Error("active root pointer schema is invalid or unknown");
    }
    if (
      path.resolve(pointer.activeRoot).toLowerCase() !==
      path.resolve(expectedRoot).toLowerCase()
    ) {
      throw new Error(
        `active root pointer does not identify expected source ${expectedRoot}`,
      );
    }
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) {
      return;
    }
    if (error.code !== "ENOENT") {
      throw error;
    }
    throw new Error(`active root pointer is missing: ${pointerPath}`, {
      cause: error,
    });
  }
}

function assertPlanMatches(plan, refreshed) {
  const fields = [
    "planId",
    "sourceRoot",
    "sourceVersion",
    "targetVersion",
    "sourceSchemaVersion",
    "sourceMutationSequence",
    "sourceManifestHash",
    "sourceStateHash",
    "backupRoot",
    "targetRoot",
    "activePointerPath",
    "backupPendingRoot",
    "targetPendingRoot",
    "transactionPath",
    "lockPath",
  ];
  for (const field of fields) {
    if (plan[field] !== refreshed[field]) {
      throw new Error(`upgrade dry-run plan derived field drifted: ${field}`);
    }
  }
  if (
    !sameManifest(plan.sourceManifest, refreshed.sourceManifest) ||
    canonicalJsonString(plan.orderedMigrations, "planned migrations") !==
      canonicalJsonString(refreshed.orderedMigrations, "refreshed migrations")
  ) {
    throw new Error("upgrade dry-run plan manifest or migration path drifted");
  }
}

async function readUpgradeRecovery(activePlan) {
  const lockExists = await pathExists(activePlan.lockPath);
  const transactionExists = await pathExists(activePlan.transactionPath);
  if (!lockExists && !transactionExists) {
    return { recoveryRequired: false };
  }
  if (!lockExists) {
    throw new Error(
      "upgrade recovery ledger is incomplete and requires manual investigation",
    );
  }

  await assertSafeControlFile(activePlan.lockPath, "upgrade recovery lock");
  const lockText = await readFile(activePlan.lockPath, "utf8");
  const lock = JSON.parse(lockText);
  const lockKeys = [
    "acquiredUtc",
    "planId",
    "schemaVersion",
    "sourceRoot",
    "targetRoot",
  ];
  if (
    lock === null ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    Object.keys(lock).length !== lockKeys.length ||
    Object.keys(lock).some((key) => !lockKeys.includes(key)) ||
    lock.schemaVersion !== SCHEMA_VERSION ||
    lock.planId !== activePlan.planId ||
    lock.sourceRoot !== activePlan.sourceRoot ||
    lock.targetRoot !== activePlan.targetRoot ||
    typeof lock.acquiredUtc !== "string" ||
    !Number.isFinite(Date.parse(lock.acquiredUtc))
  ) {
    throw new Error("upgrade recovery lock schema or ownership is invalid");
  }
  const lockSha256 = createHash("sha256")
    .update(lockText, "utf8")
    .digest("hex");
  if (!transactionExists) {
    return {
      recoveryRequired: true,
      phase: "lock-acquired",
      lockSha256,
      transaction: null,
    };
  }

  await assertSafeControlFile(
    activePlan.transactionPath,
    "upgrade recovery transaction",
  );
  const transactionText = await readFile(
    activePlan.transactionPath,
    "utf8",
  );
  const transaction = JSON.parse(transactionText);
  const phaseKeys = {
    "copying-backup": [
      "backupPendingRoot",
      "planId",
      "phase",
      "schemaVersion",
      "sourceRoot",
      "startedUtc",
      "targetPendingRoot",
    ],
    "migrating-target": [
      "backupRoot",
      "planId",
      "phase",
      "schemaVersion",
      "sourceRoot",
      "targetPendingRoot",
      "updatedUtc",
    ],
    "switch-prepared": [
      "backupRoot",
      "planId",
      "phase",
      "schemaVersion",
      "sourceRoot",
      "targetManifestHash",
      "targetRoot",
      "updatedUtc",
    ],
    switched: [
      "backupRoot",
      "planId",
      "phase",
      "schemaVersion",
      "sourceRoot",
      "switchedUtc",
      "targetManifestHash",
      "targetRoot",
    ],
    "rollback-prepared": [
      "backupRoot",
      "planId",
      "phase",
      "schemaVersion",
      "sourceRoot",
      "targetManifestHash",
      "targetRoot",
      "targetStateHash",
      "updatedUtc",
    ],
    "rolled-back": [
      "backupRoot",
      "planId",
      "phase",
      "rolledBackUtc",
      "schemaVersion",
      "sourceRoot",
      "targetRoot",
    ],
  };
  const expectedKeys = phaseKeys[transaction?.phase];
  if (
    transaction === null ||
    typeof transaction !== "object" ||
    Array.isArray(transaction) ||
    !expectedKeys ||
    Object.keys(transaction).length !== expectedKeys.length ||
    Object.keys(transaction).some((key) => !expectedKeys.includes(key)) ||
    transaction.schemaVersion !== SCHEMA_VERSION ||
    transaction.planId !== activePlan.planId ||
    transaction.sourceRoot !== activePlan.sourceRoot
  ) {
    throw new Error("upgrade recovery transaction schema or ownership is invalid");
  }
  const expectedPaths = {
    backupPendingRoot: activePlan.backupPendingRoot,
    backupRoot: activePlan.backupRoot,
    targetPendingRoot: activePlan.targetPendingRoot,
    targetRoot: activePlan.targetRoot,
  };
  for (const [key, expected] of Object.entries(expectedPaths)) {
    if (Object.hasOwn(transaction, key) && transaction[key] !== expected) {
      throw new Error(`upgrade recovery transaction path drifted: ${key}`);
    }
  }

  return {
    recoveryRequired: true,
    phase: transaction.phase,
    lockSha256,
    transactionSha256: createHash("sha256")
      .update(transactionText, "utf8")
      .digest("hex"),
    transaction,
  };
}

function createUpgradeResult(
  activePlan,
  targetStateHash,
  targetManifestAtSwitch,
  { finalized = false } = {},
) {
  let rolledBack = false;
  async function rollback() {
    if (rolledBack) {
      throw new Error("upgrade rollback has already completed");
    }
    await writeFlushedFile(
      activePlan.lockPath,
      `${canonicalJsonString({
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        acquiredUtc: new Date().toISOString(),
      }, "upgrade rollback lock")}\n`,
    ).catch((error) => {
      if (error.code === "EEXIST") {
        throw new Error("upgrade rollback is blocked by an active transaction", {
          cause: error,
        });
      }
      return unlink(activePlan.lockPath)
        .catch(() => {})
        .then(() => {
          throw error;
        });
    });
    let rollbackCommitted = false;
    let rollbackMutationStarted = false;
    try {
      await assertActiveRoot(
        activePlan.activePointerPath,
        activePlan.targetRoot,
      );
      const currentMetadata = await readRuntimeMetadata(activePlan.targetRoot);
      const currentState = await replayState(activePlan.targetRoot);
      const currentStateHash = hashCoordinatorState(currentState);
      const currentTargetManifest = await buildManifest(activePlan.targetRoot);
      if (
        currentMetadata.mutationSequence !==
          activePlan.sourceMutationSequence ||
        currentStateHash !== targetStateHash ||
        !sameManifest(currentTargetManifest, targetManifestAtSwitch)
      ) {
        throw new Error(
          "upgrade rollback boundary has new-version mutation and cannot be restored",
        );
      }
      const currentBackupManifest = await buildManifest(activePlan.backupRoot);
      if (!sameManifest(currentBackupManifest, activePlan.sourceManifest)) {
        throw new Error("upgrade backup drifted before rollback");
      }
      const currentSourceManifest = await buildManifest(activePlan.sourceRoot);
      if (!sameManifest(currentSourceManifest, activePlan.sourceManifest)) {
        throw new Error("upgrade prior source drifted before rollback");
      }
      rollbackMutationStarted = true;
      await writeAtomicJson(activePlan.transactionPath, {
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        phase: "rollback-prepared",
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        backupRoot: activePlan.backupRoot,
        targetManifestHash: manifestHash(currentTargetManifest),
        targetStateHash: currentStateHash,
        updatedUtc: new Date().toISOString(),
      });
      await writeAtomicJson(activePlan.activePointerPath, {
        schemaVersion: SCHEMA_VERSION,
        activeRoot: activePlan.sourceRoot,
        priorRoot: activePlan.targetRoot,
        planId: activePlan.planId,
        rolledBackUtc: new Date().toISOString(),
      });
      await assertActiveRoot(
        activePlan.activePointerPath,
        activePlan.sourceRoot,
      );
      await writeAtomicJson(activePlan.transactionPath, {
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        phase: "rolled-back",
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        backupRoot: activePlan.backupRoot,
        rolledBackUtc: new Date().toISOString(),
      });
      rolledBack = true;
      rollbackCommitted = true;
      return {
        activeRoot: activePlan.sourceRoot,
        restoredFrom: activePlan.sourceRoot,
        verifiedBackup: activePlan.backupRoot,
        stateHash: activePlan.sourceStateHash,
      };
    } finally {
      if (rollbackCommitted || !rollbackMutationStarted) {
        await unlink(activePlan.lockPath);
      }
    }
  }

  return {
    planId: activePlan.planId,
    sourceRoot: activePlan.sourceRoot,
    targetRoot: activePlan.targetRoot,
    backupRoot: activePlan.backupRoot,
    activeRoot: activePlan.targetRoot,
    activePointerPath: activePlan.activePointerPath,
    transactionPath: activePlan.transactionPath,
    lockPath: activePlan.lockPath,
    backupVerified: true,
    sourceStateHash: activePlan.sourceStateHash,
    targetStateHash,
    targetManifestHash: manifestHash(targetManifestAtSwitch),
    finalized,
    rollback,
  };
}

async function verifyOwnedUpgradeTarget(activePlan, targetRoot) {
  await assertSafeControlFile(
    path.join(targetRoot, "upgrade-record.json"),
    "upgrade ownership record",
  );
  const record = JSON.parse(
    await readFile(path.join(targetRoot, "upgrade-record.json"), "utf8"),
  );
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schemaVersion !== SCHEMA_VERSION ||
    record.planId !== activePlan.planId ||
    record.sourceRoot !== activePlan.sourceRoot ||
    record.targetRoot !== activePlan.targetRoot ||
    record.backupRoot !== activePlan.backupRoot ||
    record.sourceVersion !== activePlan.sourceVersion ||
    record.targetVersion !== activePlan.targetVersion ||
    record.sourceManifestHash !== activePlan.sourceManifestHash ||
    record.sourceStateHash !== activePlan.sourceStateHash ||
    record.targetStateHash !== activePlan.sourceStateHash
  ) {
    throw new Error("upgrade target ownership record is invalid");
  }
  const metadata = await readRuntimeMetadata(targetRoot);
  const recovery = await readJournalRecoveryStatus(targetRoot);
  const stateHash = hashCoordinatorState(await replayState(targetRoot));
  if (
    metadata.toolVersion !== activePlan.targetVersion ||
    metadata.mutationSequence !== activePlan.sourceMutationSequence ||
    recovery.health !== "healthy" ||
    stateHash !== activePlan.sourceStateHash
  ) {
    throw new Error("upgrade target ownership replay verification failed");
  }
}

export async function recoverRuntimeUpgrade(
  plan,
  {
    action = "inspect",
    expectedLockSha256,
    expectedTransactionSha256,
  } = {},
) {
  if (!plan || plan.dryRun !== true) {
    throw new TypeError("runtime upgrade recovery requires a dry-run plan");
  }
  const refreshed = await planRuntimeUpgrade({
    sourceRoot: plan.sourceRoot,
    targetVersion: plan.targetVersion,
  });
  assertPlanMatches(plan, refreshed);
  const activePlan = refreshed;
  const recovery = await readUpgradeRecovery(activePlan);
  if (action === "inspect" || !recovery.recoveryRequired) {
    return recovery;
  }
  if (!["abort", "finalize", "finalize-rollback"].includes(action)) {
    throw new TypeError(
      "upgrade recovery action must be inspect, abort, finalize, or finalize-rollback",
    );
  }
  if (
    typeof expectedLockSha256 !== "string" ||
    expectedLockSha256 !== recovery.lockSha256
  ) {
    throw new Error("upgrade recovery lock hash drifted");
  }
  if (
    recovery.transaction !== null &&
    (typeof expectedTransactionSha256 !== "string" ||
      expectedTransactionSha256 !== recovery.transactionSha256 ||
      (await fileSha256(activePlan.transactionPath)) !==
        expectedTransactionSha256)
  ) {
    throw new Error("upgrade recovery transaction hash drifted");
  }
  async function assertRecoveryFenceUnchanged() {
    if ((await fileSha256(activePlan.lockPath)) !== expectedLockSha256) {
      throw new Error("upgrade recovery lock hash drifted before mutation");
    }
    if (recovery.transaction === null) {
      if (await pathExists(activePlan.transactionPath)) {
        throw new Error(
          "upgrade recovery transaction appeared before mutation",
        );
      }
      return;
    }
    if (
      (await fileSha256(activePlan.transactionPath)) !==
      expectedTransactionSha256
    ) {
      throw new Error(
        "upgrade recovery transaction hash drifted before mutation",
      );
    }
  }
  if (action === "finalize-rollback") {
    if (!["rollback-prepared", "rolled-back"].includes(recovery.phase)) {
      throw new Error(
        `upgrade phase ${recovery.phase} cannot finalize rollback`,
      );
    }
    const sourceManifest = await buildManifest(activePlan.sourceRoot);
    const backupManifest = await buildManifest(activePlan.backupRoot);
    if (
      !sameManifest(sourceManifest, activePlan.sourceManifest) ||
      !sameManifest(backupManifest, activePlan.sourceManifest)
    ) {
      throw new Error("upgrade rollback recovery source or backup drifted");
    }
    await verifyOwnedUpgradeTarget(activePlan, activePlan.targetRoot);
    if (
      recovery.phase === "rollback-prepared" &&
      (manifestHash(await buildManifest(activePlan.targetRoot)) !==
        recovery.transaction.targetManifestHash ||
        recovery.transaction.targetStateHash !== activePlan.sourceStateHash)
    ) {
      throw new Error("upgrade rollback recovery target boundary drifted");
    }
    await assertRecoveryFenceUnchanged();
    try {
      await assertActiveRoot(
        activePlan.activePointerPath,
        activePlan.sourceRoot,
      );
    } catch (sourceError) {
      await assertActiveRoot(
        activePlan.activePointerPath,
        activePlan.targetRoot,
      );
      await writeAtomicJson(activePlan.activePointerPath, {
        schemaVersion: SCHEMA_VERSION,
        activeRoot: activePlan.sourceRoot,
        priorRoot: activePlan.targetRoot,
        planId: activePlan.planId,
        rolledBackUtc: new Date().toISOString(),
      });
      await assertActiveRoot(
        activePlan.activePointerPath,
        activePlan.sourceRoot,
      );
    }
    if (recovery.phase !== "rolled-back") {
      await writeAtomicJson(activePlan.transactionPath, {
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        phase: "rolled-back",
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        backupRoot: activePlan.backupRoot,
        rolledBackUtc: new Date().toISOString(),
      });
    }
    if ((await fileSha256(activePlan.lockPath)) !== expectedLockSha256) {
      throw new Error("upgrade recovery lock hash drifted before release");
    }
    await unlink(activePlan.lockPath);
    return {
      activeRoot: activePlan.sourceRoot,
      restoredFrom: activePlan.sourceRoot,
      verifiedBackup: activePlan.backupRoot,
      stateHash: activePlan.sourceStateHash,
      recovered: true,
    };
  }
  if (action === "finalize") {
    if (!["switch-prepared", "switched"].includes(recovery.phase)) {
      throw new Error(
        `upgrade phase ${recovery.phase} cannot be finalized`,
      );
    }
    await assertActiveRoot(
      activePlan.activePointerPath,
      activePlan.targetRoot,
    );
    const sourceManifest = await buildManifest(activePlan.sourceRoot);
    const backupManifest = await buildManifest(activePlan.backupRoot);
    const targetManifest = await buildManifest(activePlan.targetRoot);
    if (
      !sameManifest(sourceManifest, activePlan.sourceManifest) ||
      !sameManifest(backupManifest, activePlan.sourceManifest) ||
      manifestHash(targetManifest) !== recovery.transaction.targetManifestHash
    ) {
      throw new Error("upgrade finalize manifest verification failed");
    }
    const targetRecovery = await readJournalRecoveryStatus(
      activePlan.targetRoot,
    );
    const targetStateHash = hashCoordinatorState(
      await replayState(activePlan.targetRoot),
    );
    const targetMetadata = await readRuntimeMetadata(activePlan.targetRoot);
    if (
      targetRecovery.health !== "healthy" ||
      targetStateHash !== activePlan.sourceStateHash ||
      targetMetadata.toolVersion !== activePlan.targetVersion ||
      targetMetadata.mutationSequence !== activePlan.sourceMutationSequence
    ) {
      throw new Error("upgrade finalize replay or mutation boundary failed");
    }
    await assertRecoveryFenceUnchanged();
    if (recovery.phase === "switch-prepared") {
      await writeAtomicJson(activePlan.transactionPath, {
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        phase: "switched",
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        backupRoot: activePlan.backupRoot,
        targetManifestHash: manifestHash(targetManifest),
        switchedUtc: new Date().toISOString(),
      });
    }
    if ((await fileSha256(activePlan.lockPath)) !== expectedLockSha256) {
      throw new Error("upgrade recovery lock hash drifted before release");
    }
    await unlink(activePlan.lockPath);
    return createUpgradeResult(
      activePlan,
      targetStateHash,
      targetManifest,
      { finalized: true },
    );
  }
  if (recovery.phase === "switched") {
    throw new Error("a switched upgrade cannot be aborted as pre-switch recovery");
  }
  await assertActiveRoot(
    activePlan.activePointerPath,
    activePlan.sourceRoot,
    { allowMissing: true },
  );
  const phaseOwnedPaths = {
    "lock-acquired": [],
    "copying-backup": [
      activePlan.backupPendingRoot,
      activePlan.backupRoot,
    ],
    "migrating-target": [
      activePlan.backupRoot,
      activePlan.targetPendingRoot,
      activePlan.targetRoot,
    ],
    "switch-prepared": [
      activePlan.backupRoot,
      activePlan.targetRoot,
    ],
  };
  const ownedPaths = phaseOwnedPaths[recovery.phase];
  if (!ownedPaths) {
    throw new Error(`upgrade phase ${recovery.phase} cannot be aborted`);
  }
  if (
    ownedPaths.includes(activePlan.backupRoot) &&
    (await pathExists(activePlan.backupRoot)) &&
    !sameManifest(
      await buildManifest(activePlan.backupRoot),
      activePlan.sourceManifest,
    )
  ) {
    throw new Error("upgrade recovery backup ownership verification failed");
  }
  if (
    ownedPaths.includes(activePlan.targetRoot) &&
    (await pathExists(activePlan.targetRoot))
  ) {
    if (recovery.phase === "migrating-target") {
      await verifyOwnedUpgradeTarget(activePlan, activePlan.targetRoot);
    } else if (
      manifestHash(await buildManifest(activePlan.targetRoot)) !==
        recovery.transaction.targetManifestHash
    ) {
      throw new Error("upgrade recovery target ownership verification failed");
    }
  }
  await assertRecoveryFenceUnchanged();
  for (const candidate of ownedPaths) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) {
      throw new Error(`upgrade recovery rejects symbolic link ${candidate}`);
    }
    await rm(candidate, { recursive: details.isDirectory(), force: false });
  }
  if (await pathExists(activePlan.transactionPath)) {
    await unlink(activePlan.transactionPath);
  }
  const currentLockHash = await fileSha256(activePlan.lockPath);
  if (currentLockHash !== expectedLockSha256) {
    throw new Error("upgrade recovery lock hash drifted before release");
  }
  await unlink(activePlan.lockPath);
  return {
    recoveryRequired: false,
    aborted: true,
    planId: activePlan.planId,
  };
}

export async function executeRuntimeUpgrade(plan) {
  if (!plan || plan.dryRun !== true) {
    throw new TypeError("runtime upgrade requires a verified dry-run plan");
  }
  const refreshed = await planRuntimeUpgrade({
    sourceRoot: plan.sourceRoot,
    targetVersion: plan.targetVersion,
  });
  assertPlanMatches(plan, refreshed);
  const activePlan = refreshed;
  await mkdir(path.dirname(activePlan.backupRoot), { recursive: true });

  const existingRecovery = await readUpgradeRecovery(activePlan);
  if (existingRecovery.recoveryRequired) {
    throw new Error(
      `upgrade is recovery-required at phase ${existingRecovery.phase}`,
    );
  }

  let lockHandle;
  try {
    lockHandle = await open(activePlan.lockPath, "wx");
    await lockHandle.writeFile(
      `${canonicalJsonString({
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        acquiredUtc: new Date().toISOString(),
      }, "upgrade lock")}\n`,
      "utf8",
    );
    await lockHandle.sync();
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `upgrade is recovery-required because lock ${activePlan.lockPath} already exists`,
        { cause: error },
      );
    }
    if (lockHandle) {
      try {
        await lockHandle.close();
      } finally {
        await unlink(activePlan.lockPath).catch(() => {});
      }
    }
    throw error;
  }

  let targetStateHash;
  let targetManifestAtSwitch;
  let upgradeCommitted = false;
  try {
    await assertActiveRoot(
      activePlan.activePointerPath,
      activePlan.sourceRoot,
      { allowMissing: true },
    );
    for (const candidate of [
      activePlan.backupRoot,
      activePlan.targetRoot,
      activePlan.backupPendingRoot,
      activePlan.targetPendingRoot,
      activePlan.transactionPath,
    ]) {
      if (await pathExists(candidate)) {
        throw new Error(
          `upgrade is recovery-required because artifact already exists: ${candidate}`,
        );
      }
    }

    await writeAtomicJson(activePlan.transactionPath, {
      schemaVersion: SCHEMA_VERSION,
      planId: activePlan.planId,
      phase: "copying-backup",
      sourceRoot: activePlan.sourceRoot,
      backupPendingRoot: activePlan.backupPendingRoot,
      targetPendingRoot: activePlan.targetPendingRoot,
      startedUtc: new Date().toISOString(),
    });
    await cp(activePlan.sourceRoot, activePlan.backupPendingRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const backupManifest = await buildManifest(activePlan.backupPendingRoot);
    if (!sameManifest(backupManifest, activePlan.sourceManifest)) {
      throw new Error("upgrade backup verification failed");
    }
    if (
      !sameManifest(
        await buildManifest(activePlan.sourceRoot),
        activePlan.sourceManifest,
      )
    ) {
      throw new Error("upgrade source drifted while copying backup");
    }
    await rename(activePlan.backupPendingRoot, activePlan.backupRoot);

    await writeAtomicJson(activePlan.transactionPath, {
      schemaVersion: SCHEMA_VERSION,
      planId: activePlan.planId,
      phase: "migrating-target",
      sourceRoot: activePlan.sourceRoot,
      backupRoot: activePlan.backupRoot,
      targetPendingRoot: activePlan.targetPendingRoot,
      updatedUtc: new Date().toISOString(),
    });
    await cp(activePlan.sourceRoot, activePlan.targetPendingRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if (
      !sameManifest(
        await buildManifest(activePlan.targetPendingRoot),
        activePlan.sourceManifest,
      ) ||
      !sameManifest(
        await buildManifest(activePlan.sourceRoot),
        activePlan.sourceManifest,
      )
    ) {
      throw new Error("upgrade source or target drifted during target copy");
    }

    const targetMetadataPath = path.join(
      activePlan.targetPendingRoot,
      "runtime-version.json",
    );
    const targetMetadata = await readRuntimeMetadata(
      activePlan.targetPendingRoot,
    );
    targetMetadata.toolVersion = activePlan.targetVersion;
    await writeAtomicJson(targetMetadataPath, targetMetadata);

    const targetState = await replayState(activePlan.targetPendingRoot);
    const targetRecovery = await readJournalRecoveryStatus(
      activePlan.targetPendingRoot,
    );
    if (targetRecovery.health !== "healthy") {
      throw new Error(
        "upgrade target journal is recovery-required before active-root switch",
      );
    }
    targetStateHash = hashCoordinatorState(targetState);
    if (targetStateHash !== activePlan.sourceStateHash) {
      throw new Error("upgrade target replay state hash does not match source");
    }

    await writeAtomicJson(
      path.join(activePlan.targetPendingRoot, "upgrade-record.json"),
      {
        schemaVersion: SCHEMA_VERSION,
        planId: activePlan.planId,
        sourceRoot: activePlan.sourceRoot,
        targetRoot: activePlan.targetRoot,
        backupRoot: activePlan.backupRoot,
        sourceVersion: activePlan.sourceVersion,
        targetVersion: activePlan.targetVersion,
        orderedMigrations: activePlan.orderedMigrations,
        sourceManifestHash: activePlan.sourceManifestHash,
        sourceStateHash: activePlan.sourceStateHash,
        targetStateHash,
        preparedUtc: new Date().toISOString(),
        rollbackBoundary: {
          mutationSequence: targetMetadata.mutationSequence,
          journalSequence: targetState.lastSequence,
          stateHash: targetStateHash,
        },
      },
    );
    await rename(activePlan.targetPendingRoot, activePlan.targetRoot);
    targetManifestAtSwitch = await buildManifest(activePlan.targetRoot);

    await writeAtomicJson(activePlan.transactionPath, {
      schemaVersion: SCHEMA_VERSION,
      planId: activePlan.planId,
      phase: "switch-prepared",
      sourceRoot: activePlan.sourceRoot,
      targetRoot: activePlan.targetRoot,
      backupRoot: activePlan.backupRoot,
      targetManifestHash: manifestHash(targetManifestAtSwitch),
      updatedUtc: new Date().toISOString(),
    });
    await assertActiveRoot(
      activePlan.activePointerPath,
      activePlan.sourceRoot,
      { allowMissing: true },
    );
    if (
      !sameManifest(
        await buildManifest(activePlan.sourceRoot),
        activePlan.sourceManifest,
      )
    ) {
      throw new Error("upgrade source drifted before active-root switch");
    }
    await writeAtomicJson(activePlan.activePointerPath, {
      schemaVersion: SCHEMA_VERSION,
      activeRoot: activePlan.targetRoot,
      priorRoot: activePlan.sourceRoot,
      planId: activePlan.planId,
      switchedUtc: new Date().toISOString(),
    });
    await assertActiveRoot(
      activePlan.activePointerPath,
      activePlan.targetRoot,
    );
    await writeAtomicJson(activePlan.transactionPath, {
      schemaVersion: SCHEMA_VERSION,
      planId: activePlan.planId,
      phase: "switched",
      sourceRoot: activePlan.sourceRoot,
      targetRoot: activePlan.targetRoot,
      backupRoot: activePlan.backupRoot,
      targetManifestHash: manifestHash(targetManifestAtSwitch),
      switchedUtc: new Date().toISOString(),
    });
    upgradeCommitted = true;
  } finally {
    try {
      await lockHandle.close();
    } finally {
      if (upgradeCommitted) {
        await unlink(activePlan.lockPath);
      }
    }
  }

  return createUpgradeResult(
    activePlan,
    targetStateHash,
    targetManifestAtSwitch,
  );
}
