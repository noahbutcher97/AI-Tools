import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname, uptime } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  SCHEMA_VERSION,
  canonicalJsonString,
  validateProviderResult,
} from "../contracts.mjs";
import {
  readJournalEvents,
  readJournalRecoveryStatus,
  recoverJournalMutationFence,
} from "./journal.mjs";
import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "./reducer.mjs";

const DEFAULT_MAX_BYTES_PER_RECORD = 256 * 1024;
const MINIMUM_MAX_BYTES_PER_RECORD = 512;
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
const READ_ONLY_COMMANDS = Object.freeze([
  "status",
  "doctor",
  "explain",
  "export",
]);
const READ_ONLY_COMMAND_SET = new Set(READ_ONLY_COMMANDS);
const RESERVED_IDENTIFIERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const storeInternals = new WeakMap();
const rootMutationTails = new Map();
const rootHealthStates = new Map();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BOOT_EPOCH_MS =
  Math.floor((Date.now() - uptime() * 1_000) / 600_000) * 600_000;
const PORTABLE_BOOT_ID =
  `${hostname().toLowerCase()}:${new Date(BOOT_EPOCH_MS).toISOString()}`;
let currentWindowsProcessIdentityPromise = null;

function rootKey(rootDir) {
  return path.resolve(rootDir).toLowerCase();
}

async function withRootMutation(rootDir, operation) {
  const key = rootKey(rootDir);
  const prior = rootMutationTails.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  rootMutationTails.set(key, current);
  try {
    return await current;
  } finally {
    if (rootMutationTails.get(key) === current) {
      rootMutationTails.delete(key);
    }
  }
}

function sharedHealthState(rootDir) {
  const key = rootKey(rootDir);
  let state = rootHealthStates.get(key);
  if (!state) {
    state = {
      status: "healthy",
      degradation: null,
      lastRecoveryProbeId: null,
    };
    rootHealthStates.set(key, state);
  }
  return state;
}

function updateSharedHealth(shared, next) {
  shared.status = next.status;
  shared.degradation = next.degradation
    ? structuredClone(next.degradation)
    : null;
  shared.lastRecoveryProbeId = next.lastRecoveryProbeId ?? null;
}

function parseUtc(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be an exact UTC timestamp`);
  }
  return Date.parse(value);
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/i.test(value) ||
    RESERVED_IDENTIFIERS.has(value.toLowerCase())
  ) {
    throw new TypeError(
      `${label} must be a bounded non-reserved alphanumeric identifier`,
    );
  }
  return value;
}

function requireSha256(value, label = "evidence hash") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lower-case SHA-256 digest`);
  }
  return value;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function windowsPowerShellPath() {
  return path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function acquireEvidenceRecoveryMutex(
  rootDir,
  waitingHook = async () => {},
) {
  if (process.platform !== "win32") {
    throw new Error("evidence recovery serialization requires Windows");
  }
  const mutexName =
    "Global\\CodexCoordinatorEvidenceRecovery-" +
    sha256Bytes(Buffer.from(rootKey(rootDir), "utf8")).slice(0, 32);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$mutex = [System.Threading.Mutex]::new($false, '${mutexName}')`,
    "$acquired = $false",
    "try {",
    "try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }",
    "if (-not $acquired) { [Console]::Out.WriteLine('WAITING'); [Console]::Out.Flush() }",
    "if (-not $acquired) { try { $acquired = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $acquired = $true } }",
    "if (-not $acquired) { throw 'evidence recovery mutex acquisition timed out' }",
    "[Console]::Out.WriteLine('ACQUIRED')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadToEnd() | Out-Null",
    "} finally {",
    "if ($acquired) { $mutex.ReleaseMutex() }",
    "$mutex.Dispose()",
    "}",
  ].join("; ");
  const child = spawn(
    windowsPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  let acquired = false;
  let waitingNotified = false;
  let waitingNotification = Promise.resolve();
  const exitResult = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4_096) {
      child.kill();
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("evidence recovery mutex handshake timed out"));
    }, 15_000);
    const fail = (error) => {
      if (acquired) {
        return;
      }
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.once("error", (error) => {
      fail(new Error("evidence recovery mutex helper failed to start", {
        cause: error,
      }));
    });
    child.once("exit", (code, signal) => {
      fail(new Error(
        `evidence recovery mutex helper exited before acquisition (${code ?? signal})`,
      ));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 128) {
        fail(new Error("evidence recovery mutex handshake exceeded its bound"));
        return;
      }
      const normalized = stdout.replaceAll("\r\n", "\n");
      if (
        normalized.startsWith("WAITING\n") &&
        !waitingNotified
      ) {
        waitingNotified = true;
        waitingNotification = Promise.resolve().then(() =>
          waitingHook({ mutexHelperPid: child.pid }));
        waitingNotification.catch(fail);
      }
      if (normalized === "WAITING\n") {
        return;
      }
      if (
        normalized === "ACQUIRED\n" ||
        normalized === "WAITING\nACQUIRED\n"
      ) {
        waitingNotification.then(() => {
          acquired = true;
          clearTimeout(timer);
          resolve();
        }, fail);
      } else if (
        normalized.includes("\n") &&
        normalized !== "WAITING\n"
      ) {
        fail(new Error("evidence recovery mutex handshake was invalid"));
      }
    });
  });
  let releaseRequested = false;
  void exitResult.then(() => {
    if (!releaseRequested) {
      process.kill(process.pid, "SIGKILL");
    }
  });
  return {
    mutexHelperPid: child.pid,
    async release() {
      releaseRequested = true;
      child.stdin.end();
      const result = await exitResult;
      if (result.error) {
        throw new Error("evidence recovery mutex helper failed", {
          cause: result.error,
        });
      }
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(
          `evidence recovery mutex helper exited abnormally (${result.code ?? result.signal}): ${stderr.trim()}`,
        );
      }
    },
  };
}

async function withEvidenceRecoveryMutex(
  rootDir,
  operation,
  waitingHook,
) {
  const lease = await acquireEvidenceRecoveryMutex(
    rootDir,
    waitingHook,
  );
  try {
    return await operation({
      mutexHelperPid: lease.mutexHelperPid,
    });
  } finally {
    await lease.release();
  }
}

function utf8Prefix(text, maximumBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return text;
  }
  let length = maximumBytes;
  while (length >= 0) {
    try {
      return UTF8_DECODER.decode(bytes.subarray(0, length));
    } catch {
      length -= 1;
    }
  }
  return "";
}

function requireSafeBoundedFile(
  details,
  maximumBytes,
  label,
) {
  if (
    details.isSymbolicLink?.() ||
    !details.isFile() ||
    details.nlink !== 1
  ) {
    throw new Error(
      `${label} must be a regular single-link file`,
    );
  }
  if (
    !Number.isSafeInteger(details.size) ||
    details.size < 0 ||
    details.size > maximumBytes
  ) {
    throw new Error(`${label} exceeds its configured byte bound`);
  }
}

function sameOpenedFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedUtf8File(
  filePath,
  maximumBytes,
  label,
) {
  const before = await lstat(filePath);
  requireSafeBoundedFile(before, maximumBytes, label);
  const handle = await open(filePath, "r");
  try {
    const opened = await handle.stat();
    requireSafeBoundedFile(opened, maximumBytes, label);
    if (!sameOpenedFile(before, opened)) {
      throw new Error(`${label} identity drifted before open`);
    }
    const bounded = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const result = await handle.read(
        bounded,
        bytesRead,
        bounded.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      !sameOpenedFile(opened, after) ||
      after.size !== opened.size
    ) {
      throw new Error(`${label} identity drifted during read`);
    }
    if (bytesRead > maximumBytes) {
      throw new Error(`${label} exceeds its configured byte bound`);
    }
    return UTF8_DECODER.decode(bounded.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function readBoundedUtf8FileSync(
  filePath,
  maximumBytes,
  label,
) {
  const before = lstatSync(filePath);
  requireSafeBoundedFile(before, maximumBytes, label);
  const descriptor = openSync(filePath, "r");
  try {
    const opened = fstatSync(descriptor);
    requireSafeBoundedFile(opened, maximumBytes, label);
    if (!sameOpenedFile(before, opened)) {
      throw new Error(`${label} identity drifted before open`);
    }
    const bounded = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const count = readSync(
        descriptor,
        bounded,
        bytesRead,
        bounded.byteLength - bytesRead,
        bytesRead,
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    const after = fstatSync(descriptor);
    if (
      !sameOpenedFile(opened, after) ||
      after.size !== opened.size
    ) {
      throw new Error(`${label} identity drifted during read`);
    }
    if (bytesRead > maximumBytes) {
      throw new Error(`${label} exceeds its configured byte bound`);
    }
    return UTF8_DECODER.decode(bounded.subarray(0, bytesRead));
  } finally {
    closeSync(descriptor);
  }
}

async function assertSafePath(filePath, expectedKind, label) {
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

async function writeFlushedFile(filePath, text, flags = "wx") {
  const handle = await open(filePath, flags);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(filePath, value, label) {
  const pendingPath = `${filePath}.pending-${process.pid}-${randomUUID()}`;
  const text = `${canonicalJsonString(value, label)}\n`;
  try {
    await writeFlushedFile(pendingPath, text);
    await rename(pendingPath, filePath);
  } catch (error) {
    await rm(pendingPath, { force: true }).catch(() => {});
    throw error;
  }
}

function evidencePath(evidenceDir, sha256) {
  requireSha256(sha256);
  return path.join(
    evidenceDir,
    sha256.slice(0, 2),
    `${sha256.slice(2)}.json`,
  );
}

function addressEnvelope(fields) {
  return {
    ...fields,
    sha256: sha256Bytes(
      Buffer.from(
        canonicalJsonString(fields, "evidence address material"),
        "utf8",
      ),
    ),
  };
}

function buildBoundedEnvelope(canonical, maximumBytes) {
  const canonicalBytes = Buffer.from(canonical, "utf8");
  const originalByteLength = canonicalBytes.byteLength;
  const sourceSha256 = sha256Bytes(canonicalBytes);
  const complete = addressEnvelope({
    schemaVersion: SCHEMA_VERSION,
    sourceSha256,
    storedSha256: sha256Bytes(canonicalBytes),
    originalByteLength,
    storedByteLength: originalByteLength,
    truncated: false,
    payloadEncoding: "json",
    payload: JSON.parse(canonical),
  });
  if (
    Buffer.byteLength(
      `${canonicalJsonString(complete, "evidence envelope")}\n`,
      "utf8",
    ) <= maximumBytes
  ) {
    return complete;
  }

  let low = 0;
  let high = Math.min(originalByteLength, maximumBytes);
  let best = null;
  while (low <= high) {
    const candidateLength = Math.floor((low + high) / 2);
    const payload = utf8Prefix(canonical, candidateLength);
    const payloadBytes = Buffer.from(payload, "utf8");
    const candidate = addressEnvelope({
      schemaVersion: SCHEMA_VERSION,
      sourceSha256,
      storedSha256: sha256Bytes(payloadBytes),
      originalByteLength,
      storedByteLength: payloadBytes.byteLength,
      truncated: true,
      payloadEncoding: "canonical-json-prefix",
      payload,
    });
    const encodedLength = Buffer.byteLength(
      `${canonicalJsonString(candidate, "evidence envelope")}\n`,
      "utf8",
    );
    if (encodedLength <= maximumBytes) {
      best = candidate;
      low = candidateLength + 1;
    } else {
      high = candidateLength - 1;
    }
  }
  if (!best) {
    throw new RangeError(
      "evidence maximum bytes per record cannot contain its envelope",
    );
  }
  return best;
}

function validateEnvelope(envelope, expectedSha256) {
  const expectedKeys = new Set([
    "schemaVersion",
    "sha256",
    "sourceSha256",
    "storedSha256",
    "originalByteLength",
    "storedByteLength",
    "truncated",
    "payloadEncoding",
    "payload",
  ]);
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== expectedKeys.size ||
    Object.keys(envelope).some((key) => !expectedKeys.has(key)) ||
    envelope.schemaVersion !== SCHEMA_VERSION ||
    envelope.sha256 !== expectedSha256 ||
    typeof envelope.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.sourceSha256) ||
    typeof envelope.storedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.storedSha256) ||
    !Number.isSafeInteger(envelope.originalByteLength) ||
    envelope.originalByteLength < 0 ||
    !Number.isSafeInteger(envelope.storedByteLength) ||
    envelope.storedByteLength < 0 ||
    typeof envelope.truncated !== "boolean" ||
    !["json", "canonical-json-prefix"].includes(envelope.payloadEncoding)
  ) {
    throw new Error("evidence envelope schema or hash is invalid");
  }
  const addressMaterial = structuredClone(envelope);
  delete addressMaterial.sha256;
  if (
    sha256Bytes(
      Buffer.from(
        canonicalJsonString(addressMaterial, "evidence address material"),
        "utf8",
      ),
    ) !== expectedSha256
  ) {
    throw new Error("evidence content address is invalid");
  }
  if (envelope.truncated) {
    const payloadBytes =
      typeof envelope.payload === "string"
        ? Buffer.from(envelope.payload, "utf8")
        : null;
    if (
      envelope.payloadEncoding !== "canonical-json-prefix" ||
      !payloadBytes ||
      payloadBytes.byteLength !== envelope.storedByteLength ||
      envelope.originalByteLength <= envelope.storedByteLength ||
      sha256Bytes(payloadBytes) !== envelope.storedSha256
    ) {
      throw new Error(
        "truncated evidence stored payload hash is invalid",
      );
    }
  } else {
    const canonicalPayload = canonicalJsonString(
      envelope.payload,
      "evidence payload",
    );
    const payloadBytes = Buffer.from(canonicalPayload, "utf8");
    const payloadHash = sha256Bytes(payloadBytes);
    if (
      envelope.payloadEncoding !== "json" ||
      envelope.originalByteLength !== payloadBytes.byteLength ||
      envelope.storedByteLength !== payloadBytes.byteLength ||
      payloadHash !== envelope.sourceSha256 ||
      payloadHash !== envelope.storedSha256
    ) {
      throw new Error("evidence envelope payload hash is invalid");
    }
  }
  return structuredClone(envelope);
}

function healthMarkerPath(rootDir) {
  return path.join(rootDir, "persistence-health.json");
}

function evidenceLockPath(rootDir) {
  return path.join(rootDir, ".codex-coordinator-evidence.lock");
}

function healthyMarker(lastRecoveryProbeId = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "healthy",
    lastRecoveryProbeId,
    updatedUtc: new Date().toISOString(),
  };
}

function pendingMarker(operation, token, lastRecoveryProbeId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "mutation-pending",
    operation,
    token,
    ownerPid: process.pid,
    lastRecoveryProbeId,
    updatedUtc: new Date().toISOString(),
  };
}

function degradedMarker(error, operation, lastRecoveryProbeId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "degraded-read-only",
    operation,
    code:
      typeof error?.code === "string"
        ? error.code
        : "PERSISTENCE_FAILURE",
    message:
      typeof error?.message === "string"
        ? error.message.slice(0, 2_000)
        : "persistence failure",
    lastRecoveryProbeId,
    updatedUtc: new Date().toISOString(),
  };
}

function validateHealthMarker(marker) {
  if (
    marker === null ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.schemaVersion !== SCHEMA_VERSION ||
    !["healthy", "mutation-pending", "degraded-read-only"].includes(
      marker.status,
    ) ||
    typeof marker.updatedUtc !== "string" ||
    !Number.isFinite(Date.parse(marker.updatedUtc)) ||
    !Object.hasOwn(marker, "lastRecoveryProbeId") ||
    (marker.lastRecoveryProbeId !== null &&
      typeof marker.lastRecoveryProbeId !== "string")
  ) {
    throw new Error("persistence health marker schema is invalid");
  }
  const keys = Object.keys(marker);
  if (
    marker.status === "healthy" &&
    (keys.length !== 4 ||
      keys.some(
        (key) =>
          ![
            "schemaVersion",
            "status",
            "lastRecoveryProbeId",
            "updatedUtc",
          ].includes(key),
      ))
  ) {
    throw new Error("healthy persistence marker schema is invalid");
  }
  if (
    marker.status === "mutation-pending" &&
    (keys.length !== 7 ||
      keys.some(
        (key) =>
          ![
            "schemaVersion",
            "status",
            "operation",
            "token",
            "ownerPid",
            "lastRecoveryProbeId",
            "updatedUtc",
          ].includes(key),
      ) ||
      typeof marker.operation !== "string" ||
      typeof marker.token !== "string" ||
      !Number.isSafeInteger(marker.ownerPid) ||
      marker.ownerPid < 1)
  ) {
    throw new Error("pending persistence marker schema is invalid");
  }
  if (
    marker.status === "degraded-read-only" &&
    (keys.length !== 7 ||
      keys.some(
        (key) =>
          ![
            "schemaVersion",
            "status",
            "operation",
            "code",
            "message",
            "lastRecoveryProbeId",
            "updatedUtc",
          ].includes(key),
      ) ||
      typeof marker.operation !== "string" ||
      typeof marker.code !== "string" ||
      typeof marker.message !== "string")
  ) {
    throw new Error("degraded persistence marker schema is invalid");
  }
  return marker;
}

async function ensureHealthMarker(rootDir) {
  const markerPath = healthMarkerPath(rootDir);
  if (await assertSafePath(
    markerPath,
    "file",
    "persistence health marker",
  )) {
    return;
  }
  try {
    await writeFlushedFile(
      markerPath,
      `${canonicalJsonString(healthyMarker(), "health marker")}\n`,
    );
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function readHealthMarker(rootDir) {
  const markerPath = healthMarkerPath(rootDir);
  try {
    return validateHealthMarker(
      JSON.parse(
        await readBoundedUtf8File(
          markerPath,
          MAX_CONTROL_FILE_BYTES,
          "persistence health marker",
        ),
      ),
    );
  } catch (error) {
    throw new Error(`persistence health marker is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

function markerToHealth(marker) {
  if (marker.status === "healthy") {
    return {
      status: "healthy",
      degradation: null,
      lastRecoveryProbeId: marker.lastRecoveryProbeId,
    };
  }
  return {
    status: "degraded-read-only",
    degradation: {
      boundary: marker.operation,
      code:
        marker.status === "degraded-read-only"
          ? marker.code
          : "MUTATION_INTERRUPTED",
      message:
        marker.status === "degraded-read-only"
          ? marker.message
          : "a persistence mutation did not reach its verified commit",
      enteredUtc: marker.updatedUtc,
    },
    lastRecoveryProbeId: marker.lastRecoveryProbeId,
  };
}

function refreshSharedHealthSync(rootDir, shared) {
  try {
    const markerPath = healthMarkerPath(rootDir);
    updateSharedHealth(
      shared,
      markerToHealth(
        validateHealthMarker(
          JSON.parse(
            readBoundedUtf8FileSync(
              markerPath,
              MAX_CONTROL_FILE_BYTES,
              "persistence health marker",
            ),
          ),
        ),
      ),
    );
    const lockPath = evidenceLockPath(rootDir);
    try {
      const lockDetails = lstatSync(lockPath);
      if (
        lockDetails.isSymbolicLink() ||
        !lockDetails.isFile() ||
        lockDetails.nlink !== 1
      ) {
        throw new Error("evidence mutation lock path is unsafe");
      }
      const interrupted = new Error(
        "an evidence persistence mutation is still fenced",
      );
      interrupted.code = "MUTATION_FENCED";
      updateSharedHealth(
        shared,
        markerToHealth(
          degradedMarker(
            interrupted,
            "evidence-mutation-lock",
            shared.lastRecoveryProbeId,
          ),
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  } catch (error) {
    updateSharedHealth(
      shared,
      markerToHealth(
        degradedMarker(error, "health-marker-read", shared.lastRecoveryProbeId),
      ),
    );
  }
}

async function writeHealthMarker(rootDir, marker) {
  await writeAtomicJson(
    healthMarkerPath(rootDir),
    marker,
    "persistence health marker",
  );
}

function processGenerationId({
  pid,
  creationTimeUtc,
  executablePath,
  windowsBootId,
}) {
  return sha256Bytes(
    Buffer.from(
      [
        String(pid),
        creationTimeUtc,
        path.resolve(executablePath).toLowerCase(),
        windowsBootId,
      ].join("\0"),
      "utf8",
    ),
  );
}

function validateEvidenceProcessIdentity(value, label) {
  const expectedKeys = [
    "pid",
    "generationId",
    "creationTimeUtc",
    "executablePath",
    "windowsBootId",
  ];
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    Object.keys(value).some((key) => !expectedKeys.includes(key)) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.executablePath !== "string" ||
    value.executablePath.length < 3 ||
    value.executablePath.length > 1_024 ||
    !path.isAbsolute(value.executablePath)
  ) {
    throw new TypeError(`${label} schema is invalid`);
  }
  requireIdentifier(value.generationId, `${label} generation ID`);
  parseUtc(value.creationTimeUtc, `${label} creation time`);
  requireIdentifier(value.windowsBootId, `${label} Windows boot ID`);
  return structuredClone(value);
}

function currentProcessIdentity() {
  const creationTimeUtc = new Date(
    Math.floor(performance.timeOrigin / 1_000) * 1_000,
  ).toISOString();
  const fields = {
    pid: process.pid,
    creationTimeUtc,
    executablePath: path.resolve(process.execPath),
    windowsBootId: PORTABLE_BOOT_ID,
  };
  return {
    pid: fields.pid,
    generationId: processGenerationId(fields),
    creationTimeUtc: fields.creationTimeUtc,
    executablePath: fields.executablePath,
    windowsBootId: fields.windowsBootId,
  };
}

function processIsAlive(ownerPid) {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function queryWindowsProcessIdentity(ownerPid) {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$targetProcess = Get-Process -Id ${ownerPid} -ErrorAction Stop`,
      "$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop",
      "$result = [ordered]@{ creationTimeUtc = $targetProcess.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); executablePath = $targetProcess.Path; windowsBootId = $operatingSystem.LastBootUpTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }",
      "$result | ConvertTo-Json -Compress",
    ].join("; ");
    execFile(
      windowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          if (!processIsAlive(ownerPid)) {
            resolve(null);
            return;
          }
          reject(new Error(
            `could not inspect live evidence lock owner PID ${ownerPid}`,
            { cause: error },
          ));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          const creationTimeUtc = result.creationTimeUtc;
          const fields = {
            pid: ownerPid,
            creationTimeUtc,
            executablePath: path.resolve(result.executablePath),
            windowsBootId: result.windowsBootId,
          };
          resolve({
            pid: fields.pid,
            generationId: processGenerationId(fields),
            creationTimeUtc: fields.creationTimeUtc,
            executablePath: fields.executablePath,
            windowsBootId: fields.windowsBootId,
          });
        } catch (parseError) {
          reject(new Error(
            `could not parse live evidence lock owner PID ${ownerPid}`,
            { cause: parseError },
          ));
        }
      },
    );
  });
}

async function defaultProcessIdentityProvider(ownerPid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw new TypeError("evidence process identity PID is invalid");
  }
  if (!processIsAlive(ownerPid)) {
    return null;
  }
  if (ownerPid === process.pid) {
    if (process.platform === "win32") {
      const identityPromise =
        currentWindowsProcessIdentityPromise ??=
          queryWindowsProcessIdentity(ownerPid);
      try {
        return structuredClone(await identityPromise);
      } catch (error) {
        if (currentWindowsProcessIdentityPromise === identityPromise) {
          currentWindowsProcessIdentityPromise = null;
        }
        throw error;
      }
    }
    return currentProcessIdentity();
  }
  if (process.platform !== "win32") {
    throw new Error(
      "live evidence lock owner inspection requires Windows",
    );
  }
  return queryWindowsProcessIdentity(ownerPid);
}

function sameProcessIdentity(left, right) {
  return (
    left.pid === right.pid &&
    left.generationId === right.generationId &&
    left.creationTimeUtc === right.creationTimeUtc &&
    path.resolve(left.executablePath).toLowerCase() ===
      path.resolve(right.executablePath).toLowerCase() &&
    left.windowsBootId === right.windowsBootId
  );
}

async function acquireEvidenceLock(rootDir, operation, ownerIdentity) {
  const lockPath = evidenceLockPath(rootDir);
  const token = randomUUID();
  const text = `${canonicalJsonString({
    schemaVersion: SCHEMA_VERSION,
    operation: "evidence-mutation",
    operationName: operation,
    rootDir: path.resolve(rootDir),
    owner: validateEvidenceProcessIdentity(
      ownerIdentity,
      "evidence mutation lock owner",
    ),
    token,
    acquiredUtc: new Date().toISOString(),
  }, "evidence mutation lock")}\n`;
  try {
    await writeFlushedFile(lockPath, text);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `evidence mutation is fenced by an active or stale lock: ${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    lockPath,
    token,
    sha256: sha256Bytes(Buffer.from(text, "utf8")),
  };
}

async function releaseEvidenceLock(lock) {
  const currentText = await readBoundedUtf8File(
    lock.lockPath,
    MAX_CONTROL_FILE_BYTES,
    "evidence mutation lock",
  );
  const currentHash = sha256Bytes(
    Buffer.from(currentText, "utf8"),
  );
  if (currentHash !== lock.sha256) {
    throw new Error("evidence mutation lock identity drifted before release");
  }
  await unlink(lock.lockPath);
}

async function inspectEvidenceLock(rootDir) {
  const lockPath = evidenceLockPath(rootDir);
  if (!(await assertSafePath(
    lockPath,
    "file",
    "evidence mutation lock",
  ))) {
    return null;
  }
  const text = await readBoundedUtf8File(
    lockPath,
    MAX_CONTROL_FILE_BYTES,
    "evidence mutation lock",
  );
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    throw new Error("evidence mutation lock is invalid JSON", {
      cause: error,
    });
  }
  const keys = [
    "schemaVersion",
    "operation",
    "operationName",
    "rootDir",
    "owner",
    "token",
    "acquiredUtc",
  ];
  if (
    lock === null ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    Object.keys(lock).length !== keys.length ||
    Object.keys(lock).some((key) => !keys.includes(key)) ||
    lock.schemaVersion !== SCHEMA_VERSION ||
    lock.operation !== "evidence-mutation" ||
    typeof lock.operationName !== "string" ||
    path.resolve(lock.rootDir).toLowerCase() !==
      path.resolve(rootDir).toLowerCase() ||
    typeof lock.token !== "string" ||
    typeof lock.acquiredUtc !== "string" ||
    !Number.isFinite(Date.parse(lock.acquiredUtc))
  ) {
    throw new Error("evidence mutation lock schema or ownership is invalid");
  }
  validateEvidenceProcessIdentity(
    lock.owner,
    "evidence mutation lock owner",
  );
  return {
    ...lock,
    lockPath,
    sha256: sha256Bytes(Buffer.from(text, "utf8")),
  };
}

async function clearDeadEvidenceLock(rootDir, processIdentityProvider) {
  const lock = await inspectEvidenceLock(rootDir);
  if (!lock) {
    return false;
  }
  const liveIdentity = await processIdentityProvider(lock.owner.pid);
  if (liveIdentity !== null) {
    const validatedLiveIdentity = validateEvidenceProcessIdentity(
      liveIdentity,
      "live evidence lock owner",
    );
    if (validatedLiveIdentity.pid !== lock.owner.pid) {
      throw new Error("live evidence lock owner PID inspection drifted");
    }
    if (
      sameProcessIdentity(validatedLiveIdentity, lock.owner)
    ) {
      throw new Error(
        `evidence recovery refuses live lock owner PID ${lock.owner.pid}`,
      );
    }
    if (
      validatedLiveIdentity.creationTimeUtc ===
      lock.owner.creationTimeUtc
    ) {
      throw new Error(
        `evidence recovery refuses ambiguous live lock owner identity drift for PID ${lock.owner.pid}`,
      );
    }
  }
  const currentHash = sha256Bytes(
    Buffer.from(
      await readBoundedUtf8File(
        lock.lockPath,
        MAX_CONTROL_FILE_BYTES,
        "evidence mutation lock",
      ),
      "utf8",
    ),
  );
  if (currentHash !== lock.sha256) {
    throw new Error("evidence recovery lock hash drifted");
  }
  await unlink(lock.lockPath);
  return true;
}

function collectStateEvidenceHashes(state, hashes) {
  for (const collection of [
    state.observations?.current,
    state.observations?.lastKnownGood,
  ]) {
    if (!collection || typeof collection !== "object") {
      continue;
    }
    for (const providers of Object.values(collection)) {
      if (!providers || typeof providers !== "object") {
        continue;
      }
      for (const observation of Object.values(providers)) {
        if (
          observation &&
          typeof observation.evidenceSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(observation.evidenceSha256)
        ) {
          hashes.add(observation.evidenceSha256);
        }
      }
    }
  }
}

function collectEmbeddedEvidenceHashes(value, hashes) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEmbeddedEvidenceHashes(item, hashes);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "evidenceSha256" &&
      typeof item === "string" &&
      /^[a-f0-9]{64}$/.test(item)
    ) {
      hashes.add(item);
    } else {
      collectEmbeddedEvidenceHashes(item, hashes);
    }
  }
}

async function collectJournalEvidence(rootDir) {
  let status;
  try {
    status = await readJournalRecoveryStatus(rootDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        hashes: new Set(),
        events: [],
        state: initialCoordinatorState(),
      };
    }
    throw error;
  }
  if (status.health !== "healthy") {
    throw new Error("journal recovery must complete before evidence mutation");
  }
  const events = await readJournalEvents(rootDir);
  const hashes = new Set();
  for (const event of events) {
    collectEmbeddedEvidenceHashes(event.payload, hashes);
  }
  const state = events.reduce(
    (current, event) => reduceCoordinatorEvent(current, event),
    initialCoordinatorState(),
  );
  collectStateEvidenceHashes(state, hashes);
  return { hashes, events, state };
}

function pendingRecordPattern() {
  return /^([a-f0-9]{62}\.json)\.pending-\d+-[a-f0-9-]{36}$/i;
}

export const DEGRADED_READ_ONLY_COMMANDS = READ_ONLY_COMMANDS;

function assertJournalRoot(journal, resolvedRoot) {
  if (
    journal === null ||
    typeof journal !== "object" ||
    typeof journal.rootDir !== "string" ||
    rootKey(journal.rootDir) !== rootKey(resolvedRoot) ||
    typeof journal.readFrom !== "function" ||
    typeof journal.append !== "function"
  ) {
    throw new TypeError(
      "journal and evidence store must use the same runtime root",
    );
  }
}

export async function openEvidenceStore({
  rootDir,
  maxBytesPerRecord = DEFAULT_MAX_BYTES_PER_RECORD,
  boundaryHook = () => {},
  faultInjector = () => {},
  processIdentityProvider = defaultProcessIdentityProvider,
}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new TypeError("evidence root directory is required");
  }
  if (
    !Number.isSafeInteger(maxBytesPerRecord) ||
    maxBytesPerRecord < MINIMUM_MAX_BYTES_PER_RECORD ||
    maxBytesPerRecord > DEFAULT_MAX_BYTES_PER_RECORD
  ) {
    throw new RangeError(
      "evidence maximum bytes per record must be 512 bytes through 256 KiB",
    );
  }
  if (
    typeof boundaryHook !== "function" ||
    typeof faultInjector !== "function" ||
    typeof processIdentityProvider !== "function"
  ) {
    throw new TypeError(
      "evidence hooks and process identity provider must be functions",
    );
  }
  const ownerIdentity = validateEvidenceProcessIdentity(
    await processIdentityProvider(process.pid),
    "current evidence process",
  );
  if (ownerIdentity.pid !== process.pid) {
    throw new Error("current evidence process identity PID drifted");
  }

  const resolvedRoot = path.resolve(rootDir);
  const evidenceDir = path.join(resolvedRoot, "evidence");
  await assertSafePath(resolvedRoot, "directory", "evidence runtime root");
  await assertSafePath(evidenceDir, "directory", "evidence directory");
  await mkdir(evidenceDir, { recursive: true });
  await assertSafePath(resolvedRoot, "directory", "evidence runtime root");
  await assertSafePath(evidenceDir, "directory", "evidence directory");
  await ensureHealthMarker(resolvedRoot);
  const shared = sharedHealthState(resolvedRoot);

  async function writeHealthMarkerWithFault(marker) {
    const boundary = `health.${marker.status}`;
    await boundaryHook(`${boundary}.before`, {
      marker: structuredClone(marker),
    });
    await faultInjector(`${boundary}.before`, {
      marker: structuredClone(marker),
    });
    await writeHealthMarker(resolvedRoot, marker);
    await faultInjector(`${boundary}.after`, {
      marker: structuredClone(marker),
    });
    const verified = await readHealthMarker(resolvedRoot);
    if (
      verified.status !== marker.status ||
      verified.lastRecoveryProbeId !== marker.lastRecoveryProbeId
    ) {
      throw new Error("persistence health marker read-back drifted");
    }
  }

  async function readEnvelope(sha256) {
    requireSha256(sha256);
    const filePath = evidencePath(evidenceDir, sha256);
    if (!(await assertSafePath(filePath, "file", "evidence record"))) {
      return null;
    }
    try {
      const text = await readBoundedUtf8File(
        filePath,
        maxBytesPerRecord,
        "evidence envelope",
      );
      return validateEnvelope(JSON.parse(text), sha256);
    } catch (error) {
      throw new Error(`evidence envelope is corrupt: ${error.message}`, {
        cause: error,
      });
    }
  }

  async function listEvidenceEntries({ reconcilePending = false } = {}) {
    const records = new Set();
    const pending = [];
    const prefixEntries = await readdir(evidenceDir, {
      withFileTypes: true,
    });
    for (const prefixEntry of prefixEntries) {
      if (
        !prefixEntry.isDirectory() ||
        !/^[a-f0-9]{2}$/.test(prefixEntry.name)
      ) {
        throw new Error(
          `evidence store contains an unexpected entry: ${prefixEntry.name}`,
        );
      }
      const prefixPath = path.join(evidenceDir, prefixEntry.name);
      await assertSafePath(
        prefixPath,
        "directory",
        "evidence prefix directory",
      );
      for (const recordEntry of await readdir(prefixPath, {
        withFileTypes: true,
      })) {
        const pendingMatch = pendingRecordPattern().exec(recordEntry.name);
        if (pendingMatch) {
          const pendingPath = path.join(prefixPath, recordEntry.name);
          await assertSafePath(
            pendingPath,
            "file",
            "pending evidence record",
          );
          pending.push({ pendingPath, targetName: pendingMatch[1] });
          continue;
        }
        if (
          !recordEntry.isFile() ||
          !/^[a-f0-9]{62}\.json$/.test(recordEntry.name)
        ) {
          throw new Error(
            `evidence prefix contains an unexpected entry: ${recordEntry.name}`,
          );
        }
        const sha256 = prefixEntry.name + recordEntry.name.slice(0, -5);
        await readEnvelope(sha256);
        records.add(sha256);
      }
    }
    if (reconcilePending) {
      for (const item of pending) {
        const expectedTarget = path.join(
          path.dirname(item.pendingPath),
          item.targetName,
        );
        const sha256 =
          path.basename(path.dirname(item.pendingPath)) +
          item.targetName.slice(0, -5);
        const text = await readBoundedUtf8File(
          item.pendingPath,
          maxBytesPerRecord,
          "pending evidence envelope",
        );
        validateEnvelope(JSON.parse(text), sha256);
        if (await assertSafePath(
          expectedTarget,
          "file",
          "reconciled evidence target",
        )) {
          await readEnvelope(sha256);
          await unlink(item.pendingPath);
        } else {
          await rename(item.pendingPath, expectedTarget);
          await readEnvelope(sha256);
          records.add(sha256);
        }
      }
      return { records, pending: [] };
    }
    return { records, pending };
  }

  function prepareEvidenceEnvelope(value) {
    const canonical = canonicalJsonString(value, "evidence value");
    return buildBoundedEnvelope(canonical, maxBytesPerRecord);
  }

  async function persistEnvelopeUnlocked(envelope) {
    const sha256 = envelope.sha256;
    const targetPath = evidencePath(evidenceDir, sha256);
    const prefixDir = path.dirname(targetPath);
    const existing = await readEnvelope(sha256);
    if (existing) {
      return {
        sha256,
        byteLength: existing.originalByteLength,
        storedByteLength: existing.storedByteLength,
        truncated: existing.truncated,
      };
    }
    await boundaryHook("evidence.before", { sha256, targetPath });
    await faultInjector("evidence.directory.before", {
      sha256,
      targetPath,
    });
    await mkdir(prefixDir, { recursive: true });
    await assertSafePath(
      prefixDir,
      "directory",
      "evidence prefix directory",
    );
    await faultInjector("evidence.directory.after", {
      sha256,
      targetPath,
    });
    const pendingPath = `${targetPath}.pending-${process.pid}-${randomUUID()}`;
    try {
      await faultInjector("evidence.write.before", {
        sha256,
        targetPath,
        pendingPath,
      });
      await writeFlushedFile(
        pendingPath,
        `${canonicalJsonString(envelope, "evidence envelope")}\n`,
      );
      await faultInjector("evidence.write.after", {
        sha256,
        targetPath,
        pendingPath,
      });
      await boundaryHook("evidence.pending.after", {
        sha256,
        targetPath,
        pendingPath,
      });
      await faultInjector("evidence.replace.before", {
        sha256,
        targetPath,
        pendingPath,
      });
      try {
        await rename(pendingPath, targetPath);
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes(error.code)) {
          throw error;
        }
        const raced = await readEnvelope(sha256);
        if (!raced) {
          throw error;
        }
        await rm(pendingPath, { force: true });
      }
      await faultInjector("evidence.replace.after", {
        sha256,
        targetPath,
      });
      const verified = await readEnvelope(sha256);
      if (!verified) {
        throw new Error("atomic evidence replacement did not produce a record");
      }
      await boundaryHook("evidence.after", { sha256, targetPath });
      return {
        sha256,
        byteLength: envelope.originalByteLength,
        storedByteLength: envelope.storedByteLength,
        truncated: envelope.truncated,
      };
    } catch (error) {
      if (!(await assertSafePath(
        pendingPath,
        "file",
        "failed pending evidence record",
      ).catch(() => false))) {
        throw error;
      }
      await rm(pendingPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function persistUnlocked(value) {
    return persistEnvelopeUnlocked(prepareEvidenceEnvelope(value));
  }

  async function forceDegradedUnlocked(error, operation) {
    updateSharedHealth(shared, markerToHealth(
      degradedMarker(error, operation, shared.lastRecoveryProbeId),
    ));
    const existingLock = await inspectEvidenceLock(resolvedRoot)
      .catch(() => null);
    if (existingLock) {
      return;
    }
    const lock = await acquireEvidenceLock(
      resolvedRoot,
      operation,
      ownerIdentity,
    );
    try {
      await writeHealthMarkerWithFault(
        degradedMarker(error, operation, shared.lastRecoveryProbeId),
      );
      await releaseEvidenceLock(lock);
    } catch {
      // Retain the durable lock when no verified degraded marker exists.
    }
  }

  async function forceDegraded(error, operation) {
    await withRootMutation(resolvedRoot, () =>
      forceDegradedUnlocked(error, operation));
  }

  async function runMutationUnlocked(
    operation,
    {
      allowDegraded = false,
      preflight = async () => {},
      action,
      recoveryProbeId = null,
    },
  ) {
    const marker = await readHealthMarker(resolvedRoot);
    updateSharedHealth(shared, markerToHealth(marker));
    if (!allowDegraded && marker.status !== "healthy") {
      throw new Error(
        `${operation} is blocked while persistence is degraded read-only`,
      );
    }
    const lock = await acquireEvidenceLock(
      resolvedRoot,
      operation,
      ownerIdentity,
    );
    let pendingWritten = false;
    let persistenceAttempted = false;
    try {
      const currentMarker = await readHealthMarker(resolvedRoot);
      updateSharedHealth(shared, markerToHealth(currentMarker));
      if (!allowDegraded && currentMarker.status !== "healthy") {
        throw new Error(
          `${operation} is blocked while persistence is degraded read-only`,
        );
      }
      await preflight();
      persistenceAttempted = true;
      const pending = pendingMarker(
        operation,
        lock.token,
        recoveryProbeId ?? shared.lastRecoveryProbeId,
      );
      await writeHealthMarkerWithFault(pending);
      pendingWritten = true;
      updateSharedHealth(shared, markerToHealth(pending));
      const result = await action();
      const finalMarker = healthyMarker(
        recoveryProbeId ?? shared.lastRecoveryProbeId,
      );
      await writeHealthMarkerWithFault(finalMarker);
      updateSharedHealth(shared, markerToHealth(finalMarker));
      await releaseEvidenceLock(lock);
      return result;
    } catch (error) {
      if (pendingWritten && error.persistenceHealthyAbort) {
        try {
          const healthy = healthyMarker(shared.lastRecoveryProbeId);
          await writeHealthMarkerWithFault(healthy);
          updateSharedHealth(shared, markerToHealth(healthy));
          await releaseEvidenceLock(lock);
          throw error;
        } catch (restoreError) {
          if (restoreError === error) {
            throw error;
          }
          error = restoreError;
          error.persistenceDegraded = true;
        }
      }
      if (
        pendingWritten ||
        persistenceAttempted ||
        error.persistenceIntegrityFailure
      ) {
        error.persistenceDegraded = true;
        const degraded = degradedMarker(
          error,
          operation,
          shared.lastRecoveryProbeId,
        );
        updateSharedHealth(shared, markerToHealth(degraded));
        try {
          await writeHealthMarkerWithFault(degraded);
        } catch (markerError) {
          markerError.persistenceDegraded = true;
          updateSharedHealth(
            shared,
            markerToHealth(
              degradedMarker(
                markerError,
                operation,
                degraded.lastRecoveryProbeId,
              ),
            ),
          );
          // The existing mutation lock is the durable fail-closed fence.
          throw markerError;
        }
      }
      await releaseEvidenceLock(lock).catch(() => {});
      throw error;
    }
  }

  function runMutation(operation, options) {
    return withRootMutation(resolvedRoot, () =>
      runMutationUnlocked(operation, options));
  }

  async function verifyAuthoritativeEvidence() {
    const journal = await collectJournalEvidence(resolvedRoot);
    for (const sha256 of journal.hashes) {
      if (!(await readEnvelope(sha256))) {
        throw new Error(
          `journal-referenced evidence is missing: ${sha256}`,
        );
      }
    }
    return journal;
  }

  await withRootMutation(resolvedRoot, async () => {
    try {
      const marker = await readHealthMarker(resolvedRoot);
      updateSharedHealth(shared, markerToHealth(marker));
      const lock = await inspectEvidenceLock(resolvedRoot);
      const inventory = await listEvidenceEntries();
      if (lock || inventory.pending.length > 0) {
        const interrupted = new Error(
          "evidence persistence has an interrupted mutation",
        );
        interrupted.code = "MUTATION_INTERRUPTED";
        const degraded = degradedMarker(
          interrupted,
          `startup-reconciliation:${
            lock?.operationName ??
            (marker.status === "mutation-pending"
              ? marker.operation
              : "unknown")
          }`,
          marker.lastRecoveryProbeId,
        );
        updateSharedHealth(shared, markerToHealth(degraded));
        await writeHealthMarker(resolvedRoot, degraded).catch(() => {});
      }
      const journal = await verifyAuthoritativeEvidence();
      if (journal.state.runtime.health === "degraded-read-only") {
        const degraded = degradedMarker(
          new Error("journal records degraded persistence"),
          "journal-replay",
          journal.state.runtime.lastRecoveryProbeId,
        );
        updateSharedHealth(shared, markerToHealth(degraded));
        await writeHealthMarker(resolvedRoot, degraded).catch(() => {});
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        const degraded = degradedMarker(
          error,
          "startup-inspection",
          shared.lastRecoveryProbeId,
        );
        updateSharedHealth(shared, markerToHealth(degraded));
        await writeHealthMarker(resolvedRoot, degraded).catch(() => {});
      }
    }
  });

  const api = {
    maxBytesPerRecord,
    pathFor(sha256) {
      return evidencePath(evidenceDir, sha256);
    },
    health() {
      refreshSharedHealthSync(resolvedRoot, shared);
      return structuredClone(shared);
    },
    canRunCommand(command) {
      refreshSharedHealthSync(resolvedRoot, shared);
      return (
        shared.status === "healthy" ||
        READ_ONLY_COMMAND_SET.has(command)
      );
    },
    assertCommandAllowed(command) {
      if (!api.canRunCommand(command)) {
        throw new Error(
          `${String(command)} is blocked while persistence is degraded read-only`,
        );
      }
    },
    beginSensorGeneration(input) {
      refreshSharedHealthSync(resolvedRoot, shared);
      if (shared.status !== "healthy") {
        throw new Error(
          "sensor generation is blocked while persistence is degraded read-only",
        );
      }
      return beginSensorGeneration(input);
    },
    async put(value) {
      const envelope = prepareEvidenceEnvelope(value);
      return runMutation("evidence-put", {
        action: () => persistEnvelopeUnlocked(envelope),
      });
    },
    async get(sha256) {
      requireSha256(sha256);
      try {
        const envelope = await readEnvelope(sha256);
        if (!envelope) {
          const authoritative = await collectJournalEvidence(resolvedRoot);
          if (authoritative.hashes.has(sha256)) {
            throw new Error(
              `journal-referenced evidence is missing: ${sha256}`,
            );
          }
        }
        return envelope;
      } catch (error) {
        await forceDegraded(error, "evidence-read");
        throw error;
      }
    },
    prune(referencedHashes, cutoffUtc) {
      const cutoff = parseUtc(cutoffUtc, "evidence prune cutoff");
      const callerReferences =
        referencedHashes instanceof Set
          ? new Set(referencedHashes)
          : new Set(referencedHashes ?? []);
      for (const sha256 of callerReferences) {
        requireSha256(sha256, "referenced evidence hash");
      }
      return runMutation("evidence-prune", {
        action: async () => {
          const authoritative = await verifyAuthoritativeEvidence();
          const references = new Set([
            ...callerReferences,
            ...authoritative.hashes,
          ]);
          const inventory = await listEvidenceEntries();
          if (inventory.pending.length > 0) {
            throw new Error(
              "evidence prune refuses unresolved pending records",
            );
          }
          let deleted = 0;
          for (const sha256 of inventory.records) {
            if (references.has(sha256)) {
              continue;
            }
            const recordPath = evidencePath(evidenceDir, sha256);
            const details = await stat(recordPath);
            if (details.mtimeMs > cutoff) {
              continue;
            }
            await readEnvelope(sha256);
            await unlink(recordPath);
            deleted += 1;
          }
          return {
            deleted,
            retainedReferences: references.size,
          };
        },
      });
    },
    async recoverPersistence({ journal, probeId, timestampUtc }) {
      assertJournalRoot(journal, resolvedRoot);
      requireIdentifier(probeId, "recovery probe ID");
      parseUtc(timestampUtc, "recovery timestamp");
      const recover = async ({ mutexHelperPid }) => {
        const startingMarker = await readHealthMarker(resolvedRoot);
        const startingEvents = await journal.readFrom(0);
        const matchingRecoveryEvents = startingEvents.filter(
          (event) =>
            event.type === "runtime.recovered" &&
            event.payload.probeId === probeId,
        );
        const existingRecovery = matchingRecoveryEvents.at(0) ?? null;
        const existingIsLast =
          matchingRecoveryEvents.length === 1 &&
          existingRecovery?.eventId === startingEvents.at(-1)?.eventId;
        if (startingMarker.status === "healthy") {
          if (
            startingMarker.lastRecoveryProbeId === probeId &&
            existingIsLast
          ) {
            try {
              await verifyAuthoritativeEvidence();
              return {
                status: "healthy",
                degradation: null,
                lastRecoveryProbeId: probeId,
              };
            } catch (error) {
              await forceDegradedUnlocked(
                error,
                "persistence-recovery-verification",
              );
              throw error;
            }
          }
          throw new Error(
            "persistence recovery is not required because the runtime is already healthy",
          );
        }
        const retryingInterruptedRecovery =
          startingMarker.lastRecoveryProbeId === probeId &&
          startingMarker.operation.includes("persistence-recovery");
        await clearDeadEvidenceLock(
          resolvedRoot,
          processIdentityProvider,
        );
        await boundaryHook("recovery.lock-cleared", {
          probeId,
          mutexHelperPid,
        });
        const result = await runMutationUnlocked(
          "persistence-recovery",
          {
            allowDegraded: true,
            recoveryProbeId: probeId,
            action: async () => {
              await listEvidenceEntries({ reconcilePending: true });
              const status = await readJournalRecoveryStatus(resolvedRoot);
              if (status.mutationFence) {
                await recoverJournalMutationFence(resolvedRoot, {
                  expectedLockSha256:
                    status.mutationFence.lockSha256,
                });
              }
              const verifiedBefore = await verifyAuthoritativeEvidence();
              for (const sha256 of verifiedBefore.hashes) {
                if (!(await readEnvelope(sha256))) {
                  throw new Error(
                    `journal-referenced evidence is missing: ${sha256}`,
                  );
                }
              }
              const currentEvents = await journal.readFrom(0);
              const currentMatches = currentEvents.filter(
                (event) =>
                  event.type === "runtime.recovered" &&
                  event.payload.probeId === probeId,
              );
              const currentRecovery = currentMatches.at(0) ?? null;
              if (currentMatches.length > 0) {
                if (
                  !retryingInterruptedRecovery ||
                  currentMatches.length !== 1 ||
                  currentRecovery.eventId !== currentEvents.at(-1)?.eventId ||
                  !(await readEnvelope(
                    currentRecovery.payload.evidenceSha256,
                  ))
                ) {
                  throw new Error(
                    "recovery probe ID is stale, duplicated, or not the latest durable event",
                  );
                }
                await verifyAuthoritativeEvidence();
                return {
                  status: "healthy",
                  degradation: null,
                  lastRecoveryProbeId: probeId,
                };
              }
              const projected = currentEvents.reduce(
                (state, event) =>
                  reduceCoordinatorEvent(state, event),
                initialCoordinatorState(),
              );
              if (projected.runtime.health !== "degraded-read-only") {
                await appendNextFlushedEvent(
                  journal,
                  (sequence) => ({
                    schemaVersion: SCHEMA_VERSION,
                    sequence,
                    eventId: randomUUID(),
                    timestampUtc: startingMarker.updatedUtc,
                    source: "core.evidence-store",
                    type: "runtime.degraded",
                    payload: {
                      reason:
                        startingMarker.message ??
                        "interrupted persistence mutation",
                      boundary: startingMarker.operation,
                      code:
                        startingMarker.code ??
                        "MUTATION_INTERRUPTED",
                    },
                  }),
                  (events, candidate) => {
                    const candidateState = events
                      .concat(candidate)
                      .reduce(
                        (state, event) =>
                          reduceCoordinatorEvent(state, event),
                        initialCoordinatorState(),
                      );
                    if (
                      candidateState.runtime.health !==
                      "degraded-read-only"
                    ) {
                      throw new Error(
                        "recovery could not establish a durable degraded boundary",
                      );
                    }
                  },
                );
              }
              await boundaryHook("recovery.before", { probeId });
              const probe = await persistUnlocked({
                kind: "persistence-recovery-probe",
                probeId,
                timestampUtc,
              });
              if (!(await readEnvelope(probe.sha256))) {
                throw new Error(
                  "recovery evidence probe could not be verified",
                );
              }
              const event = await appendNextFlushedEvent(
                journal,
                (sequence) => ({
                  schemaVersion: SCHEMA_VERSION,
                  sequence,
                  eventId: randomUUID(),
                  timestampUtc,
                  source: "core.evidence-store",
                  type: "runtime.recovered",
                  payload: {
                    probeId,
                    evidenceSha256: probe.sha256,
                  },
                }),
              );
              const readBack = (
                await journal.readFrom(event.sequence - 1)
              ).at(0);
              if (readBack?.eventId !== event.eventId) {
                throw new Error(
                  "recovery journal probe was not durably verified",
                );
              }
              await boundaryHook("recovery.after", {
                probeId,
                eventId: event.eventId,
              });
              await verifyAuthoritativeEvidence();
              return {
                status: "healthy",
                degradation: null,
                lastRecoveryProbeId: probeId,
              };
            },
          },
        );
        return result;
      };
      return withRootMutation(resolvedRoot, () =>
        withEvidenceRecoveryMutex(
          resolvedRoot,
          recover,
          (details) => boundaryHook("recovery.mutex.waiting", {
            probeId,
            ...details,
          }),
        ),
      );
    },
  };
  storeInternals.set(api, {
    resolvedRoot,
    boundaryHook,
    persistUnlocked,
    readEnvelope,
    runMutation,
    verifyAuthoritativeEvidence,
  });
  return api;
}

export function beginSensorGeneration({
  sensorId,
  generationId,
  startedUtc,
}) {
  requireIdentifier(sensorId, "sensor ID");
  requireIdentifier(generationId, "sensor generation ID");
  const started = parseUtc(startedUtc, "sensor generation start");
  const staged = new Map();

  return {
    stage(providerId, result) {
      requireIdentifier(providerId, "provider ID");
      if (staged.has(providerId)) {
        throw new Error(`provider ${providerId} is already staged`);
      }
      if (staged.size >= 100) {
        throw new RangeError(
          "sensor generation cannot stage more than 100 providers",
        );
      }
      const validated = validateProviderResult(result);
      if (
        Object.hasOwn(validated, "generationId") &&
        validated.generationId !== generationId
      ) {
        throw new Error("provider generation ID does not match transaction");
      }
      staged.set(providerId, validated);
      return staged.size;
    },
    toSample(completedUtc) {
      const completed = parseUtc(
        completedUtc,
        "sensor generation completion",
      );
      if (completed < started) {
        throw new RangeError(
          "sensor generation completion cannot precede its start",
        );
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        sensorId,
        generationId,
        startedUtc,
        completedUtc,
        durationMs: completed - started,
        providerResults: Object.fromEntries(
          [...staged.entries()].sort(([left], [right]) =>
            left.localeCompare(right)),
        ),
      };
    },
  };
}

function validateSample(sample) {
  const allowedKeys = new Set([
    "schemaVersion",
    "sensorId",
    "generationId",
    "startedUtc",
    "completedUtc",
    "durationMs",
    "providerResults",
  ]);
  if (
    !isPlainRecord(sample) ||
    Object.keys(sample).length !== allowedKeys.size ||
    Object.keys(sample).some((key) => !allowedKeys.has(key)) ||
    sample.schemaVersion !== SCHEMA_VERSION ||
    !isPlainRecord(sample.providerResults)
  ) {
    throw new TypeError("sensor sample schema is invalid");
  }
  requireIdentifier(sample.sensorId, "sensor ID");
  requireIdentifier(sample.generationId, "sensor generation ID");
  const started = parseUtc(sample.startedUtc, "sensor generation start");
  const completed = parseUtc(
    sample.completedUtc,
    "sensor generation completion",
  );
  if (
    completed < started ||
    !Number.isSafeInteger(sample.durationMs) ||
    sample.durationMs !== completed - started
  ) {
    throw new Error("sensor sample duration boundary is invalid");
  }
  if (Object.keys(sample.providerResults).length > 100) {
    throw new RangeError("sensor sample has too many providers");
  }
  const providerResults = {};
  for (const providerId of Object.keys(sample.providerResults).sort()) {
    requireIdentifier(providerId, "provider ID");
    const result = validateProviderResult(
      sample.providerResults[providerId],
    );
    if (
      Object.hasOwn(result, "generationId") &&
      result.generationId !== sample.generationId
    ) {
      throw new Error(
        "provider generation ID does not match sensor sample",
      );
    }
    providerResults[providerId] = result;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sensorId: sample.sensorId,
    generationId: sample.generationId,
    startedUtc: sample.startedUtc,
    completedUtc: sample.completedUtc,
    durationMs: sample.durationMs,
    providerResults,
  };
}

async function appendNextFlushedEvent(
  journal,
  createEvent,
  validateCandidate = () => {},
) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const currentEvents = await journal.readFrom(0);
    const priorSequence = currentEvents.at(-1)?.sequence ?? 0;
    const event = createEvent(priorSequence + 1);
    await validateCandidate(currentEvents, event);
    try {
      await journal.append(event, { flush: true });
      return event;
    } catch (error) {
      if (
        !(error instanceof RangeError) ||
        !/journal sequence must be/i.test(error.message)
      ) {
        throw error;
      }
      const advancedEvents = await journal.readFrom(priorSequence);
      if ((advancedEvents.at(-1)?.sequence ?? priorSequence) <= priorSequence) {
        throw error;
      }
    }
  }
  const contention = new Error(
    "journal sequence contention did not settle after 32 retries",
  );
  contention.code = "JOURNAL_CONTENTION";
  throw contention;
}

async function recordDegradation(journal, error, boundary) {
  try {
    await appendNextFlushedEvent(
      journal,
      (sequence) => ({
        schemaVersion: SCHEMA_VERSION,
        sequence,
        eventId: randomUUID(),
        timestampUtc: new Date().toISOString(),
        source: "core.evidence-store",
        type: "runtime.degraded",
        payload: {
          reason:
            typeof error?.message === "string"
              ? error.message.slice(0, 2_000)
              : "persistence failure",
          boundary,
          code:
            typeof error?.code === "string"
              ? error.code
              : "PERSISTENCE_FAILURE",
        },
      }),
    );
  } catch {
    // The independent write-ahead health marker remains fail-closed.
  }
}

export async function commitSensorGeneration({
  journal,
  evidence,
  sample,
}) {
  const internals = storeInternals.get(evidence);
  if (!internals) {
    throw new TypeError(
      "sample commit requires an evidence store opened by this module",
    );
  }
  assertJournalRoot(journal, internals.resolvedRoot);
  const validatedSample = validateSample(sample);
  try {
    return await internals.runMutation("sensor-sample-commit", {
      preflight: async () => {
        let journalState;
        try {
          journalState = await internals.verifyAuthoritativeEvidence();
        } catch (error) {
          error.persistenceIntegrityFailure = true;
          throw error;
        }
        if (
          journalState.events.some(
            (event) =>
              event.type === "sensor.sampleCommitted" &&
              event.payload.sensorId === validatedSample.sensorId &&
              event.payload.generationId ===
                validatedSample.generationId,
          )
        ) {
          const duplicate = new Error(
            `sensor generation ${validatedSample.generationId} is already committed`,
          );
          duplicate.code = "DUPLICATE_GENERATION";
          throw duplicate;
        }
      },
      action: async () => {
        const providers = {};
        for (const [providerId, result] of Object.entries(
          validatedSample.providerResults,
        )) {
          const stored = await internals.persistUnlocked(result);
          providers[providerId] = {
            status: result.status,
            evidenceSha256: stored.sha256,
            byteLength: stored.byteLength,
            truncated: stored.truncated,
            ...(Object.hasOwn(result, "durationMs")
              ? { durationMs: result.durationMs }
              : {}),
          };
        }
        await internals.boundaryHook("sample.before", {
          sensorId: validatedSample.sensorId,
          generationId: validatedSample.generationId,
        });
        for (const provider of Object.values(providers)) {
          if (!(await internals.readEnvelope(
            provider.evidenceSha256,
          ))) {
            throw new Error(
              `staged evidence is missing: ${provider.evidenceSha256}`,
            );
          }
        }
        const payload = {
          sensorId: validatedSample.sensorId,
          generationId: validatedSample.generationId,
          startedUtc: validatedSample.startedUtc,
          completedUtc: validatedSample.completedUtc,
          durationMs: validatedSample.durationMs,
          providers,
        };
        let event;
        try {
          event = await appendNextFlushedEvent(
            journal,
            (sequence) => ({
              schemaVersion: SCHEMA_VERSION,
              sequence,
              eventId: randomUUID(),
              timestampUtc: validatedSample.completedUtc,
              source: "core.evidence-store",
              type: "sensor.sampleCommitted",
              payload,
            }),
            (currentEvents, candidate) => {
              if (
                currentEvents.some(
                  (item) =>
                    item.type === "sensor.sampleCommitted" &&
                    item.payload.sensorId === validatedSample.sensorId &&
                    item.payload.generationId ===
                      validatedSample.generationId,
                )
              ) {
                const duplicate = new Error(
                  `sensor generation ${validatedSample.generationId} is already committed`,
                );
                duplicate.code = "DUPLICATE_GENERATION";
                throw duplicate;
              }
              try {
                currentEvents
                  .concat(candidate)
                  .reduce(
                    (state, item) =>
                      reduceCoordinatorEvent(state, item),
                    initialCoordinatorState(),
                  );
              } catch (error) {
                error.persistenceHealthyAbort = true;
                throw error;
              }
            },
          );
        } catch (error) {
          if (
            ["DUPLICATE_GENERATION", "JOURNAL_CONTENTION"].includes(
              error.code,
            )
          ) {
            error.persistenceHealthyAbort = true;
          }
          throw error;
        }
        const readBack = (
          await journal.readFrom(event.sequence - 1)
        ).at(0);
        if (readBack?.eventId !== event.eventId) {
          throw new Error("sample journal commit was not durably verified");
        }
        for (const provider of Object.values(providers)) {
          if (!(await internals.readEnvelope(
            provider.evidenceSha256,
          ))) {
            throw new Error(
              `committed evidence is missing: ${provider.evidenceSha256}`,
            );
          }
        }
        await internals.boundaryHook("sample.after", {
          sensorId: validatedSample.sensorId,
          generationId: validatedSample.generationId,
        });
        return structuredClone(payload);
      },
    });
  } catch (error) {
    if (error.persistenceDegraded) {
      await recordDegradation(
        journal,
        error,
        "sensor-sample-commit",
      );
    }
    throw error;
  }
}
