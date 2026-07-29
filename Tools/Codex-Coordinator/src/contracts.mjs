import path from "node:path";

export const SCHEMA_VERSION = 1;

export const MIGRATION_MODES = Object.freeze([
  "legacy-active",
  "shadow-observe",
  "cutover-prepared",
  "unified-active",
  "rollback-prepared",
]);

export const EVENT_TYPES = Object.freeze([
  "runtime.started",
  "runtime.stopped",
  "runtime.degraded",
  "runtime.recovered",
  "appServer.connected",
  "appServer.disconnected",
  "peer.registered",
  "peer.attached",
  "peer.unregistered",
  "message.enqueued",
  "message.dispatching",
  "message.completed",
  "message.deliveryUnknown",
  "message.failed",
  "message.acknowledged",
  "conversation.closed",
  "sensor.enabled",
  "sensor.disabled",
  "sensor.sampleCompleted",
  "sensor.sampleFailed",
  "sensor.sampleCommitted",
  "observation.changed",
  "alert.opened",
  "alert.updated",
  "alert.acknowledged",
  "alert.closed",
  "state.checkpoint",
  "migration.transitionPrepared",
  "migration.transitionCommitted",
  "migration.transitionAborted",
]);

const PROVIDER_STATUSES = Object.freeze([
  "observed",
  "unavailable",
  "timed-out",
  "invalid",
]);

const MONITOR_KINDS = Object.freeze([
  "submitted-depot-head",
  "perforce-candidate",
  "resolve-clean",
  "file-baseline",
  "path-inventory",
  "process-inventory",
  "memory",
  "peer-activity",
  "lane-signal",
]);

const EVIDENCE_POLICIES = Object.freeze(["metadata", "sha256"]);
const SAMPLING_TIERS = Object.freeze(["scheduled", "expensive", "wake-only"]);
const MIN_NODE_VERSION = Object.freeze([18, 18, 0]);
const MIN_POWERSHELL_VERSION = Object.freeze([7, 4, 0]);

const EVENT_KEYS = new Set([
  "schemaVersion",
  "sequence",
  "eventId",
  "timestampUtc",
  "source",
  "type",
  "payload",
  "correlationId",
  "causationId",
]);

const PROVIDER_RESULT_KEYS = new Set([
  "status",
  "value",
  "diagnostic",
  "durationMs",
  "generationId",
  "operation",
  "truncated",
  "byteLength",
]);

const MONITOR_KEYS = new Set([
  "monitorId",
  "kind",
  "enabled",
  "ownerPeerId",
  "reason",
  "activatedUtc",
  "expiresUtc",
  "expectedPaths",
  "frozenHashes",
  "evidencePolicy",
  "samplingTier",
  "recursiveFileLimit",
  "graceSeconds",
  "version",
]);

const CONFIG_KEYS = new Set([
  "schemaVersion",
  "workspaceId",
  "workspaceRoot",
  "runtimeRoot",
  "monitorProposalSource",
  "networkPolicy",
  "filesystemPolicy",
  "runtimeVersions",
]);

const RUNTIME_VERSION_KEYS = new Set(["node", "powershell"]);
const EVENT_REQUIRED_KEYS = new Set([
  "schemaVersion",
  "sequence",
  "eventId",
  "timestampUtc",
  "source",
  "type",
  "payload",
]);
const MONITOR_REQUIRED_KEYS = new Set([
  "monitorId",
  "kind",
  "enabled",
  "ownerPeerId",
  "reason",
  "activatedUtc",
  "expectedPaths",
  "frozenHashes",
  "evidencePolicy",
  "samplingTier",
  "recursiveFileLimit",
  "version",
]);
const CONFIG_REQUIRED_KEYS = new Set(CONFIG_KEYS);
const MAX_PROVIDER_BYTES = 256 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} contains an unknown symbol key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable) {
      throw new TypeError(`${label} key ${key} must be enumerable`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} key ${key} must be a data property`);
    }
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unknown key: ${key}`);
    }
  }
}

function requireOwnKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} requires own property ${key}`);
    }
  }
}

function requireString(value, label, maximumLength = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new TypeError(
      `${label} must be a non-empty string up to ${maximumLength} characters`,
    );
  }
  return value;
}

function requireIdentifierString(value, label, maximumLength = 256) {
  requireString(value, label, maximumLength);
  if (/[\0\r\n]/.test(value)) {
    throw new TypeError(`${label} cannot contain control line characters`);
  }
  return value;
}

function parseUtc(value, label) {
  requireString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${label} must be an exact UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a UTC timestamp`);
  }
  return timestamp;
}

function parseVersion(value, label) {
  requireString(value, label, 64);
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new TypeError(`${label} must be a semantic version`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isVersionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) {
      return true;
    }
    if (actual[index] < minimum[index]) {
      return false;
    }
  }
  return true;
}

function normalizeAbsolutePath(value, label) {
  requireString(value, label, 1_024);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} cannot contain control characters`);
  }
  const windowsPath = value.replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(windowsPath)) {
    throw new TypeError(
      `${label} must be an absolute path with an explicit local drive`,
    );
  }
  const segments = windowsPath.slice(3).split("\\").filter(Boolean);
  if (segments.length === 0) {
    throw new TypeError(`${label} cannot be a drive root`);
  }
  for (const segment of segments) {
    if (
      segment.includes(":") ||
      /[ .]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
    ) {
      throw new TypeError(
        `${label} contains a non-canonical Win32 path segment`,
      );
    }
  }
  const normalized = path.win32.normalize(windowsPath);
  if (/^[A-Za-z]:\\$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\\+$/, "");
}

function pathsOverlap(first, second) {
  const isWithin = (candidate, root) => {
    const relative = path.win32.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(relative))
    );
  };
  return isWithin(first, second) || isWithin(second, first);
}

function normalizeWorkspaceRelativePath(value, label) {
  requireString(value, label, 1_024);
  const slashed = value.replaceAll("\\", "/");
  const segments = slashed.split("/").filter(Boolean);
  if (
    /[\u0000-\u001f\u007f]/.test(slashed) ||
    slashed.includes(":") ||
    /^[A-Za-z]:/.test(slashed) ||
    path.posix.isAbsolute(slashed) ||
    path.win32.isAbsolute(value) ||
    slashed.startsWith("//") ||
    segments.some(
      (segment) =>
        /[ .]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    )
  ) {
    throw new TypeError(`${label} must remain workspace-relative`);
  }
  const normalized = path.posix.normalize(slashed);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new TypeError(`${label} escapes the workspace`);
  }
  return normalized;
}

function assertDenseArray(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${label} cannot be sparse`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= value.length
    ) {
      throw new TypeError(`${label} contains a non-index property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} entries must be enumerable data properties`);
    }
  }
}

function assertJsonValue(value, label, depth = 0, stack = new Set()) {
  if (depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${label} exceeds the maximum JSON depth`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} numbers must be finite JSON values`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} must contain JSON values only`);
  }
  if (stack.has(value)) {
    throw new TypeError(`${label} cannot contain cyclic JSON data`);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, label);
      for (let index = 0; index < value.length; index += 1) {
        assertJsonValue(
          value[index],
          `${label}[${index}]`,
          depth + 1,
          stack,
        );
      }
      return;
    }
    requirePlainObject(value, label);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${label} contains a symbol outside JSON`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(
          `${label}.${key} must be an enumerable JSON data property`,
        );
      }
      assertJsonValue(
        descriptor.value,
        `${label}.${key}`,
        depth + 1,
        stack,
      );
    }
  } finally {
    stack.delete(value);
  }
}

function requireJsonBytes(value, label, maximumBytes) {
  const byteLength = Buffer.byteLength(
    canonicalJsonString(value, label),
    "utf8",
  );
  if (byteLength > maximumBytes) {
    throw new RangeError(
      `${label} exceeds the ${maximumBytes}-byte JSON limit`,
    );
  }
}

export function canonicalJsonString(value, label = "JSON value") {
  assertJsonValue(value, label);

  const serialize = (item) => {
    if (item === null) {
      return "null";
    }
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      const entries = [];
      for (let index = 0; index < item.length; index += 1) {
        entries.push(serialize(item[index]));
      }
      return `[${entries.join(",")}]`;
    }
    const entries = Reflect.ownKeys(item)
      .sort((first, second) => (first < second ? -1 : first > second ? 1 : 0))
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
      });
    return `{${entries.join(",")}}`;
  };

  return serialize(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    const result = [];
    Object.setPrototypeOf(result, null);
    for (let index = 0; index < value.length; index += 1) {
      result[index] = cloneJsonValue(value[index]);
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      Object.defineProperty(result, key, {
        value: cloneJsonValue(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return value;
}

function immutableClone(value) {
  return deepFreeze(cloneJsonValue(value));
}

export function assertPeerId(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError("peer ID must be an integer from 0 through 100");
  }
  return value;
}

export function validateEvent(value) {
  requirePlainObject(value, "event");
  rejectUnknownKeys(value, EVENT_KEYS, "event");
  requireOwnKeys(value, EVENT_REQUIRED_KEYS, "event");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new RangeError(`event schema must be ${SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new RangeError("event sequence must be a positive safe integer");
  }
  requireIdentifierString(value.eventId, "event ID", 128);
  parseUtc(value.timestampUtc, "event timestamp");
  requireIdentifierString(value.source, "event source", 128);
  if (!EVENT_TYPES.includes(value.type)) {
    throw new TypeError(`unknown event type: ${String(value.type)}`);
  }
  requirePlainObject(value.payload, "event payload");
  requireJsonBytes(
    value.payload,
    "event payload",
    MAX_EVENT_PAYLOAD_BYTES,
  );
  if (Object.hasOwn(value, "correlationId")) {
    requireIdentifierString(value.correlationId, "correlation ID", 128);
  }
  if (Object.hasOwn(value, "causationId")) {
    requireIdentifierString(value.causationId, "causation ID", 128);
  }
  return immutableClone(value);
}

export function validateProviderResult(value) {
  requirePlainObject(value, "provider result");
  rejectUnknownKeys(value, PROVIDER_RESULT_KEYS, "provider result");
  requireOwnKeys(value, new Set(["status"]), "provider result");
  if (!PROVIDER_STATUSES.includes(value.status)) {
    throw new TypeError(`unknown provider status: ${String(value.status)}`);
  }
  if (
    value.status === "observed" &&
    (!Object.hasOwn(value, "value") || value.value === undefined)
  ) {
    throw new TypeError("observed provider result requires value");
  }
  if (value.status !== "observed" && Object.hasOwn(value, "value")) {
    throw new TypeError("non-observed provider result cannot contain value");
  }
  if (Object.hasOwn(value, "value")) {
    requireJsonBytes(value.value, "provider value", MAX_PROVIDER_BYTES);
  }
  if (Object.hasOwn(value, "diagnostic")) {
    requireString(value.diagnostic, "provider diagnostic", 4_000);
  }
  if (
    Object.hasOwn(value, "durationMs") &&
    (!Number.isFinite(value.durationMs) || value.durationMs < 0)
  ) {
    throw new RangeError("provider duration must be non-negative");
  }
  if (Object.hasOwn(value, "generationId")) {
    requireString(value.generationId, "provider generation ID", 128);
  }
  if (Object.hasOwn(value, "operation")) {
    requireString(value.operation, "provider operation", 128);
  }
  if (
    Object.hasOwn(value, "truncated") &&
    typeof value.truncated !== "boolean"
  ) {
    throw new TypeError("provider truncated must be boolean");
  }
  if (
    Object.hasOwn(value, "byteLength") &&
    (!Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 0 ||
      value.byteLength > MAX_PROVIDER_BYTES)
  ) {
    throw new RangeError(
      "provider byte length must be between 0 and 256 KiB",
    );
  }
  return immutableClone(value);
}

export function validateMonitor(value) {
  requirePlainObject(value, "monitor");
  rejectUnknownKeys(value, MONITOR_KEYS, "monitor");
  requireOwnKeys(value, MONITOR_REQUIRED_KEYS, "monitor");
  requireString(value.monitorId, "monitor ID", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.monitorId)) {
    throw new TypeError("monitor ID must be lower-case dash-separated text");
  }
  if (!MONITOR_KINDS.includes(value.kind)) {
    throw new TypeError(`unknown monitor kind: ${String(value.kind)}`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new TypeError("monitor enabled must be boolean");
  }
  assertPeerId(value.ownerPeerId);
  requireString(value.reason, "monitor reason", 2_000);
  const activated = parseUtc(value.activatedUtc, "monitor activation");
  if (Object.hasOwn(value, "expiresUtc") && value.expiresUtc !== null) {
    const expires = parseUtc(value.expiresUtc, "monitor expiry");
    if (expires <= activated) {
      throw new RangeError("monitor expiry must be after activation");
    }
  }
  if (!Array.isArray(value.expectedPaths) || value.expectedPaths.length > 100) {
    throw new RangeError("monitor expected paths must contain at most 100 paths");
  }
  assertDenseArray(value.expectedPaths, "monitor expected paths");
  const normalizedPaths = value.expectedPaths.map((item, index) =>
    normalizeWorkspaceRelativePath(item, `monitor path ${index}`),
  );
  if (new Set(normalizedPaths.map((item) => item.toLowerCase())).size !== normalizedPaths.length) {
    throw new TypeError("monitor paths must be unique");
  }
  requirePlainObject(value.frozenHashes, "monitor frozen hashes");
  for (const key of Reflect.ownKeys(value.frozenHashes)) {
    if (typeof key !== "string") {
      throw new TypeError("monitor frozen hashes cannot contain symbol keys");
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      value.frozenHashes,
      key,
    );
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(
        "monitor frozen hashes must be enumerable data properties",
      );
    }
  }
  const hashEntries = Object.entries(value.frozenHashes);
  if (hashEntries.length > 100) {
    throw new RangeError("monitor frozen hashes must contain at most 100 entries");
  }
  const normalizedHashEntries = [];
  const normalizedHashPaths = new Set();
  for (const [entryPath, sha256] of hashEntries) {
    const normalizedHashPath = normalizeWorkspaceRelativePath(
      entryPath,
      "monitor hash path",
    );
    const comparisonKey = normalizedHashPath.toLowerCase();
    if (normalizedHashPaths.has(comparisonKey)) {
      throw new TypeError("monitor hash paths must be unique after normalization");
    }
    normalizedHashPaths.add(comparisonKey);
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new TypeError("monitor hash must be a SHA-256 hex digest");
    }
    normalizedHashEntries.push([normalizedHashPath, sha256.toLowerCase()]);
  }
  if (!EVIDENCE_POLICIES.includes(value.evidencePolicy)) {
    throw new TypeError(
      `unknown evidence policy: ${String(value.evidencePolicy)}`,
    );
  }
  if (!SAMPLING_TIERS.includes(value.samplingTier)) {
    throw new TypeError(`unknown sampling tier: ${String(value.samplingTier)}`);
  }
  if (
    !Number.isInteger(value.recursiveFileLimit) ||
    value.recursiveFileLimit < 0 ||
    value.recursiveFileLimit > 2_000
  ) {
    throw new RangeError("monitor recursive file limit must be 0 through 2,000");
  }
  if (
    Object.hasOwn(value, "graceSeconds") &&
    (!Number.isInteger(value.graceSeconds) ||
      value.graceSeconds < 0 ||
      value.graceSeconds > 86_400)
  ) {
    throw new RangeError("monitor grace seconds must be 0 through 86,400");
  }
  if (value.version !== SCHEMA_VERSION) {
    throw new RangeError(`monitor version must be ${SCHEMA_VERSION}`);
  }
  const normalized = cloneJsonValue(value);
  normalized.expectedPaths = normalizedPaths;
  normalized.frozenHashes = immutableClone(
    Object.fromEntries(normalizedHashEntries),
  );
  return deepFreeze(normalized);
}

export function loadCoordinatorConfig(value) {
  requirePlainObject(value, "coordinator config");
  rejectUnknownKeys(value, CONFIG_KEYS, "coordinator config");
  requireOwnKeys(value, CONFIG_REQUIRED_KEYS, "coordinator config");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new RangeError(`config schema must be ${SCHEMA_VERSION}`);
  }
  requireString(value.workspaceId, "workspace ID", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.workspaceId)) {
    throw new TypeError("workspace ID must be lower-case dash-separated text");
  }
  const normalizedWorkspaceRoot = normalizeAbsolutePath(
    value.workspaceRoot,
    "workspace root",
  );
  const normalizedRuntimeRoot = normalizeAbsolutePath(
    value.runtimeRoot,
    "runtime root",
  );
  if (pathsOverlap(normalizedWorkspaceRoot, normalizedRuntimeRoot)) {
    throw new TypeError("workspace root and runtime root must not overlap");
  }
  normalizeWorkspaceRelativePath(
    value.monitorProposalSource,
    "monitor proposal source",
  );
  if (value.networkPolicy !== "disabled") {
    throw new TypeError("network policy must be disabled");
  }
  if (value.filesystemPolicy !== "workspace") {
    throw new TypeError("filesystem policy must be workspace");
  }
  requirePlainObject(value.runtimeVersions, "runtime versions");
  rejectUnknownKeys(
    value.runtimeVersions,
    RUNTIME_VERSION_KEYS,
    "runtime versions",
  );
  requireOwnKeys(
    value.runtimeVersions,
    RUNTIME_VERSION_KEYS,
    "runtime versions",
  );
  const nodeVersion = parseVersion(value.runtimeVersions.node, "Node version");
  if (!isVersionAtLeast(nodeVersion, MIN_NODE_VERSION)) {
    throw new RangeError("Node version must be at least 18.18.0");
  }
  const powershellVersion = parseVersion(
    value.runtimeVersions.powershell,
    "PowerShell version",
  );
  if (!isVersionAtLeast(powershellVersion, MIN_POWERSHELL_VERSION)) {
    throw new RangeError("PowerShell version must be at least 7.4");
  }
  const normalized = cloneJsonValue(value);
  normalized.workspaceRoot = normalizedWorkspaceRoot;
  normalized.runtimeRoot = normalizedRuntimeRoot;
  normalized.monitorProposalSource = normalizeWorkspaceRelativePath(
    value.monitorProposalSource,
    "monitor proposal source",
  );
  return deepFreeze(normalized);
}
