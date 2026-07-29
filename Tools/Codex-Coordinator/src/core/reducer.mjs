import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import {
  EVENT_TYPES,
  MIGRATION_MODES,
  SCHEMA_VERSION,
  canonicalJsonString,
  validateEvent,
} from "../contracts.mjs";

const MAX_SENSOR_COUNT = 100;
const MAX_RECENT_GENERATIONS_PER_SENSOR = 128;
const MAX_CHECKPOINT_STATE_BYTES = 900 * 1024;
const ALLOWED_MIGRATION_TRANSITIONS = new Map([
  ["legacy-active", new Set(["shadow-observe"])],
  ["shadow-observe", new Set(["cutover-prepared"])],
  ["cutover-prepared", new Set(["unified-active"])],
  ["unified-active", new Set(["rollback-prepared"])],
  ["rollback-prepared", new Set(["legacy-active"])],
]);
const MIGRATION_OWNER_IDS = new Set(["legacy", "unified"]);
const RESERVED_MIGRATION_IDENTIFIERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PROVIDER_STATUSES = new Set([
  "observed",
  "unavailable",
  "timed-out",
  "invalid",
]);
const STATE_KEYS = new Set([
  "schemaVersion",
  "lastSequence",
  "runtime",
  "sensors",
  "observations",
  "alerts",
  "migration",
  "eventCounts",
]);

export function stableStringify(value) {
  return canonicalJsonString(value, "coordinator state");
}

export function initialCoordinatorState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastSequence: 0,
    runtime: {
      status: "stopped",
      health: "healthy",
      generationId: null,
      degradation: null,
      lastRecoveryProbeId: null,
    },
    sensors: {},
    observations: {
      current: {},
      lastKnownGood: {},
    },
    alerts: {},
    migration: {
      mode: "legacy-active",
      pendingTransition: null,
      lastTransition: null,
    },
    eventCounts: {},
  };
}

export function hashCoordinatorState(state) {
  const logicalState = structuredClone(state);
  delete logicalState.lastSequence;
  return createHash("sha256")
    .update(stableStringify(logicalState), "utf8")
    .digest("hex");
}

function validateState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== STATE_KEYS.size ||
    Object.keys(value).some((key) => !STATE_KEYS.has(key)) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(value.lastSequence) ||
    value.lastSequence < 0
  ) {
    throw new TypeError("coordinator state is invalid");
  }
  const serialized = stableStringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_STATE_BYTES) {
    throw new RangeError(
      "coordinator state exceeds its checkpoint byte budget",
    );
  }
  validateRuntimeState(value.runtime);
  validateSensorState(value.sensors);
  validateObservationState(value.observations, value.sensors);
  const alerts = requirePlainRecord(value.alerts, "coordinator alerts");
  if (Object.keys(alerts).length !== 0) {
    throw new TypeError("coordinator alerts state is invalid");
  }
  validateEventCounts(value.eventCounts, value.lastSequence);
  validateMigrationState(
    value.migration,
    value.lastSequence,
    value.eventCounts,
  );
}

function requirePlainRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain record`);
  }
  return value;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return (
    keys.length === expected.size &&
    keys.every((key) => expected.has(key))
  );
}

function validateRuntimeState(runtime) {
  requirePlainRecord(runtime, "coordinator runtime");
  const expected = new Set([
    "status",
    "health",
    "generationId",
    "degradation",
    "lastRecoveryProbeId",
  ]);
  if (
    !hasExactKeys(runtime, expected) ||
    !["stopped", "running"].includes(runtime.status) ||
    !["healthy", "degraded-read-only"].includes(runtime.health) ||
    (runtime.generationId !== null &&
      typeof runtime.generationId !== "string") ||
    (runtime.lastRecoveryProbeId !== null &&
      typeof runtime.lastRecoveryProbeId !== "string") ||
    (runtime.degradation !== null &&
      (typeof runtime.degradation !== "object" ||
        Array.isArray(runtime.degradation))) ||
    (runtime.health === "healthy" && runtime.degradation !== null) ||
    (runtime.health === "degraded-read-only" &&
      runtime.degradation === null)
  ) {
    throw new TypeError("coordinator runtime state is invalid");
  }
}

function validateSensorState(sensors) {
  requirePlainRecord(sensors, "coordinator sensors");
  const sensorIds = Object.keys(sensors);
  if (sensorIds.length > MAX_SENSOR_COUNT) {
    throw new RangeError("coordinator sensor state exceeds its bound");
  }
  const expected = new Set([
    "lastGenerationId",
    "lastCompletedUtc",
    "committedGenerations",
  ]);
  for (const sensorId of sensorIds) {
    requireSampleIdentifier(sensorId, "sensor ID");
    const sensor = requirePlainRecord(
      sensors[sensorId],
      `sensor ${sensorId}`,
    );
    const generations = requirePlainRecord(
      sensor.committedGenerations,
      `sensor ${sensorId} generation history`,
    );
    if (
      !hasExactKeys(sensor, expected) ||
      (sensor.lastGenerationId !== null &&
        typeof sensor.lastGenerationId !== "string") ||
      (sensor.lastCompletedUtc !== null &&
        typeof sensor.lastCompletedUtc !== "string") ||
      Object.keys(generations).length >
        MAX_RECENT_GENERATIONS_PER_SENSOR
    ) {
      throw new TypeError(`sensor ${sensorId} state is invalid`);
    }
    if (sensor.lastGenerationId !== null) {
      requireSampleIdentifier(sensor.lastGenerationId, "sensor generation ID");
      requireSampleUtc(sensor.lastCompletedUtc, "sensor completion");
      if (
        sensor.committedGenerations[sensor.lastGenerationId] !==
        sensor.lastCompletedUtc
      ) {
        throw new TypeError(
          `sensor ${sensorId} latest generation is not retained`,
        );
      }
    } else if (
      sensor.lastCompletedUtc !== null ||
      Object.keys(generations).length !== 0
    ) {
      throw new TypeError(`sensor ${sensorId} completion state is invalid`);
    }
    for (const [generationId, completedUtc] of Object.entries(generations)) {
      requireSampleIdentifier(generationId, "sensor generation ID");
      requireSampleUtc(completedUtc, "sensor generation completion");
      if (
        sensor.lastCompletedUtc !== null &&
        completedUtc > sensor.lastCompletedUtc
      ) {
        throw new TypeError(
          `sensor ${sensorId} generation history exceeds its latest completion`,
        );
      }
    }
  }
}

function validateObservationState(observations, sensors) {
  requirePlainRecord(observations, "coordinator observations");
  const expected = new Set(["current", "lastKnownGood"]);
  if (!hasExactKeys(observations, expected)) {
    throw new TypeError("coordinator observations state is invalid");
  }
  for (const collectionName of expected) {
    const collection = requirePlainRecord(
      observations[collectionName],
      `coordinator ${collectionName} observations`,
    );
    for (const [sensorId, providersValue] of Object.entries(collection)) {
      requireSampleIdentifier(sensorId, "sensor ID");
      if (!Object.hasOwn(sensors, sensorId)) {
        throw new TypeError(
          `${collectionName} observations reference an unknown sensor`,
        );
      }
      const providers = requirePlainRecord(
        providersValue,
        `${collectionName} provider observations`,
      );
      if (Object.keys(providers).length > 100) {
        throw new RangeError("provider observation state exceeds its bound");
      }
      for (const [providerId, observationValue] of Object.entries(providers)) {
        requireSampleIdentifier(providerId, "provider ID");
        const observation = requirePlainRecord(
          observationValue,
          `provider ${providerId} observation`,
        );
        const allowed = new Set([
          "generationId",
          "status",
          "evidenceSha256",
          "byteLength",
          "truncated",
          "observedUtc",
          "durationMs",
        ]);
        if (
          Object.keys(observation).some((key) => !allowed.has(key)) ||
          !["generationId", "status", "evidenceSha256", "byteLength",
            "truncated", "observedUtc"].every((key) =>
              Object.hasOwn(observation, key)) ||
          !PROVIDER_STATUSES.has(observation.status) ||
          typeof observation.evidenceSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(observation.evidenceSha256) ||
          !Number.isSafeInteger(observation.byteLength) ||
          observation.byteLength < 0 ||
          typeof observation.truncated !== "boolean" ||
          (Object.hasOwn(observation, "durationMs") &&
            (!Number.isFinite(observation.durationMs) ||
              observation.durationMs < 0))
        ) {
          throw new TypeError(`provider ${providerId} observation is invalid`);
        }
        requireSampleIdentifier(
          observation.generationId,
          "sensor generation ID",
        );
        requireSampleUtc(observation.observedUtc, "observation timestamp");
        const completedUtc =
          sensors[sensorId].committedGenerations[
            observation.generationId
          ];
        if (
          typeof completedUtc !== "string" ||
          observation.observedUtc !== completedUtc
        ) {
          throw new TypeError(
            `${collectionName} observation references an unknown or mismatched generation`,
          );
        }
        if (
          collectionName === "current" &&
          observation.generationId !==
            sensors[sensorId].lastGenerationId
        ) {
          throw new TypeError(
            "current observation does not match the latest generation",
          );
        }
        if (
          collectionName === "lastKnownGood" &&
          observation.status !== "observed"
        ) {
          throw new TypeError(
            "last-known-good observation must have observed status",
          );
        }
      }
    }
  }
  for (const [sensorId, currentProviders] of Object.entries(
    observations.current,
  )) {
    const lastKnownGoodProviders =
      observations.lastKnownGood[sensorId] ?? {};
    for (const [providerId, observation] of Object.entries(
      currentProviders,
    )) {
      if (
        observation.status === "observed" &&
        (!Object.hasOwn(lastKnownGoodProviders, providerId) ||
          stableStringify(observation) !==
            stableStringify(lastKnownGoodProviders[providerId]))
      ) {
        throw new TypeError(
          "observed current entry must match last-known-good observation",
        );
      }
    }
  }
}

const MIGRATION_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/;
const MIGRATION_UUID_PATTERN_CASE_INSENSITIVE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/i;

function requireMigrationUuid(value, label) {
  if (
    typeof value !== "string" ||
    !MIGRATION_UUID_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${label} must be a canonical lower-case migration UUID`,
    );
  }
}

function requireDistinctMigrationUuids(entries, label) {
  const values = entries.map(([name, value]) => {
    requireMigrationUuid(value, name);
    return value.toLowerCase();
  });
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} UUIDs must be mutually distinct`);
  }
}

function migrationUuidSequence(value, label) {
  requireMigrationUuid(value, label);
  const [first, second, third] = value.toLowerCase().split("-");
  const sequence = Number.parseInt(
    `${first}${second}${third.slice(1)}`,
    16,
  );
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError(`${label} does not contain a valid sequence`);
  }
  return sequence;
}

export function createMigrationUuid(sequence) {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      "migration UUID sequence must be a positive safe integer",
    );
  }
  const sequenceHex = sequence.toString(16).padStart(15, "0");
  const entropy = randomBytes(8).toString("hex").slice(0, 15);
  return [
    sequenceHex.slice(0, 8),
    sequenceHex.slice(8, 12),
    `8${sequenceHex.slice(12, 15)}`,
    `8${entropy.slice(0, 3)}`,
    entropy.slice(3, 15),
  ].join("-");
}

function requireMigrationSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lower-case SHA-256 digest`);
  }
}

export function requireAllowedMigrationTransition(priorMode, nextMode) {
  if (
    !MIGRATION_MODES.includes(priorMode) ||
    !MIGRATION_MODES.includes(nextMode) ||
    !ALLOWED_MIGRATION_TRANSITIONS.get(priorMode)?.has(nextMode)
  ) {
    throw new TypeError(
      `forbidden migration transition ${String(priorMode)} -> ${String(nextMode)}`,
    );
  }
}

function requireMigrationExactKeys(value, keys, label) {
  requirePlainRecord(value, label);
  if (!hasExactKeys(value, new Set(keys))) {
    throw new TypeError(`${label} schema is invalid`);
  }
}

function requireMigrationIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/i.test(value) ||
    RESERVED_MIGRATION_IDENTIFIERS.has(value.toLowerCase())
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function requireMigrationWindowsPath(value, label) {
  const segments =
    typeof value === "string"
      ? value.slice(3).split("\\")
      : [];
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 1_024 ||
    !/^[a-z]:\\/i.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    path.win32.normalize(value) !== value ||
    value.endsWith("\\") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        /[<>:"/|?*]/.test(segment) ||
        /[ .]$/.test(segment) ||
        /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(
          segment,
        ),
    )
  ) {
    throw new TypeError(
      `${label} must be a canonical absolute Windows path`,
    );
  }
}

function migrationOwnerForMode(mode) {
  return ["legacy-active", "shadow-observe", "cutover-prepared"].includes(
    mode,
  )
    ? "legacy"
    : "unified";
}

function validateMigrationProcessIdentity(value, label, windowsBootId) {
  requireMigrationExactKeys(
    value,
    [
      "generationId",
      "pid",
      "creationTimeUtc",
      "executablePath",
      "bootId",
    ],
    label,
  );
  requireMigrationIdentifier(value.generationId, `${label} generation ID`);
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new TypeError(`${label} PID must be a positive safe integer`);
  }
  requireSampleUtc(value.creationTimeUtc, `${label} creation time`);
  requireMigrationWindowsPath(value.executablePath, `${label} executable`);
  requireMigrationIdentifier(value.bootId, `${label} boot ID`);
  if (value.bootId !== windowsBootId) {
    throw new Error(`${label} Windows boot identity is contradictory`);
  }
}

function validateMigrationOwnerBoundary(
  value,
  label,
  priorMode,
  nextMode,
) {
  requireMigrationExactKeys(
    value,
    ["priorOwners", "nextOwners"],
    label,
  );
  for (const key of ["priorOwners", "nextOwners"]) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length !== 1 ||
      !MIGRATION_OWNER_IDS.has(value[key][0])
    ) {
      throw new Error(`${label} requires exactly one registered owner`);
    }
  }
  if (
    value.priorOwners[0] !== migrationOwnerForMode(priorMode) ||
    value.nextOwners[0] !== migrationOwnerForMode(nextMode)
  ) {
    throw new Error(`${label} ownership contradicts migration modes`);
  }
}

export function validateMigrationEvidence(
  value,
  priorMode,
  nextMode,
) {
  requireAllowedMigrationTransition(priorMode, nextMode);
  requireMigrationExactKeys(
    value,
    [
      "schemaVersion",
      "windowsBootId",
      "processes",
      "eventFile",
      "journal",
      "routingOwnership",
      "compatibilityOutputOwnership",
      "appServer",
      "rollbackBoundary",
    ],
    "migration evidence",
  );
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError("migration evidence schema version is unsupported");
  }
  requireMigrationIdentifier(value.windowsBootId, "Windows boot ID");

  requireMigrationExactKeys(
    value.processes,
    ["supervisor", "legacy"],
    "migration process identities",
  );
  validateMigrationProcessIdentity(
    value.processes.supervisor,
    "supervisor process",
    value.windowsBootId,
  );
  validateMigrationProcessIdentity(
    value.processes.legacy,
    "legacy process",
    value.windowsBootId,
  );
  if (
    value.processes.supervisor.pid === value.processes.legacy.pid &&
    value.processes.supervisor.creationTimeUtc ===
      value.processes.legacy.creationTimeUtc
  ) {
    throw new Error(
      "supervisor and legacy process identities are not exclusive",
    );
  }

  requireMigrationExactKeys(
    value.eventFile,
    ["byteLength", "cursor", "remainder", "fingerprintSha256"],
    "event-file boundary",
  );
  if (
    !Number.isSafeInteger(value.eventFile.byteLength) ||
    value.eventFile.byteLength < 0 ||
    !Number.isSafeInteger(value.eventFile.cursor) ||
    value.eventFile.cursor < 0 ||
    value.eventFile.cursor > value.eventFile.byteLength ||
    typeof value.eventFile.remainder !== "string" ||
    Buffer.byteLength(value.eventFile.remainder, "utf8") > 4_096 ||
    Buffer.byteLength(value.eventFile.remainder, "utf8") !==
      value.eventFile.byteLength - value.eventFile.cursor
  ) {
    throw new TypeError(
      "event-file length, cursor, or remainder is invalid",
    );
  }
  requireMigrationSha256(
    value.eventFile.fingerprintSha256,
    "event-file fingerprint",
  );

  requireMigrationExactKeys(
    value.journal,
    ["sequence", "checkpointSha256"],
    "journal boundary",
  );
  if (
    !Number.isSafeInteger(value.journal.sequence) ||
    value.journal.sequence < 0
  ) {
    throw new TypeError("journal boundary sequence is invalid");
  }
  requireMigrationSha256(
    value.journal.checkpointSha256,
    "journal checkpoint hash",
  );

  validateMigrationOwnerBoundary(
    value.routingOwnership,
    "routing owner boundary",
    priorMode,
    nextMode,
  );
  validateMigrationOwnerBoundary(
    value.compatibilityOutputOwnership,
    "compatibility-output owner boundary",
    priorMode,
    nextMode,
  );

  requireMigrationExactKeys(
    value.appServer,
    [
      "generationId",
      "pid",
      "creationTimeUtc",
      "executablePath",
      "bootId",
      "attachmentGeneration",
    ],
    "app-server identity",
  );
  validateMigrationProcessIdentity(
    {
      generationId: value.appServer.generationId,
      pid: value.appServer.pid,
      creationTimeUtc: value.appServer.creationTimeUtc,
      executablePath: value.appServer.executablePath,
      bootId: value.appServer.bootId,
    },
    "app-server process",
    value.windowsBootId,
  );
  requireMigrationIdentifier(
    value.appServer.attachmentGeneration,
    "app-server attachment generation",
  );
  for (const [role, identity] of Object.entries(value.processes)) {
    if (
      value.appServer.pid === identity.pid &&
      value.appServer.creationTimeUtc === identity.creationTimeUtc
    ) {
      throw new Error(
        `app-server and ${role} process identities are not exclusive`,
      );
    }
  }

  requireMigrationExactKeys(
    value.rollbackBoundary,
    [
      "eventCursor",
      "eventFingerprintSha256",
      "frozenLegacyConfigSha256",
    ],
    "rollback boundary",
  );
  if (
    !Number.isSafeInteger(value.rollbackBoundary.eventCursor) ||
    value.rollbackBoundary.eventCursor < 0 ||
    value.rollbackBoundary.eventCursor > value.eventFile.byteLength
  ) {
    throw new TypeError("rollback event cursor is invalid");
  }
  requireMigrationSha256(
    value.rollbackBoundary.eventFingerprintSha256,
    "rollback event fingerprint",
  );
  requireMigrationSha256(
    value.rollbackBoundary.frozenLegacyConfigSha256,
    "frozen legacy configuration hash",
  );
  if (
    value.rollbackBoundary.eventCursor !== value.eventFile.cursor ||
    value.rollbackBoundary.eventFingerprintSha256 !==
      value.eventFile.fingerprintSha256
  ) {
    throw new Error(
      "rollback boundary contradicts the event-file boundary",
    );
  }

  return JSON.parse(
    canonicalJsonString(value, "migration evidence"),
  );
}

export function hashMigrationEvidence(evidence) {
  return createHash("sha256")
    .update(canonicalJsonString(evidence, "migration evidence"), "utf8")
    .digest("hex");
}

function validateMigrationEvidenceHash(
  evidence,
  expectedHash,
  priorMode,
  nextMode,
) {
  const validated = validateMigrationEvidence(
    evidence,
    priorMode,
    nextMode,
  );
  requireMigrationSha256(expectedHash, "migration evidence hash");
  if (hashMigrationEvidence(validated) !== expectedHash) {
    throw new Error("migration evidence hash does not match");
  }
}

function validatePreparedMigrationPayload(payload) {
  requirePlainRecord(payload, "prepared migration payload");
  const expected = new Set([
    "transitionId",
    "token",
    "priorMode",
    "nextMode",
    "evidence",
    "evidenceHash",
    "preparedUtc",
  ]);
  if (!hasExactKeys(payload, expected)) {
    throw new TypeError("prepared migration payload schema is invalid");
  }
  requireMigrationUuid(payload.transitionId, "migration transition ID");
  requireMigrationUuid(payload.token, "migration transition token");
  requireAllowedMigrationTransition(payload.priorMode, payload.nextMode);
  validateMigrationEvidenceHash(
    payload.evidence,
    payload.evidenceHash,
    payload.priorMode,
    payload.nextMode,
  );
  requireSampleUtc(payload.preparedUtc, "migration prepare timestamp");
}

function validateTerminalMigrationPayload(payload, status) {
  requirePlainRecord(payload, `${status} migration payload`);
  const expected = new Set([
    "transitionId",
    "token",
    "preparedEventId",
    "priorMode",
    "nextMode",
    "evidenceHash",
    ...(status === "aborted" ? ["reason"] : []),
  ]);
  if (!hasExactKeys(payload, expected)) {
    throw new TypeError(`${status} migration payload schema is invalid`);
  }
  requireMigrationUuid(payload.transitionId, "migration transition ID");
  requireMigrationUuid(payload.token, "migration transition token");
  requireMigrationUuid(payload.preparedEventId, "prepared migration event ID");
  requireAllowedMigrationTransition(payload.priorMode, payload.nextMode);
  requireMigrationSha256(payload.evidenceHash, "migration evidence hash");
  if (
    status === "aborted" &&
    (typeof payload.reason !== "string" ||
      payload.reason.length < 1 ||
      payload.reason.length > 2_000)
  ) {
    throw new TypeError("migration abort reason is invalid");
  }
}

function validatePendingMigrationTransition(
  transition,
  lastSequence,
  label,
) {
  requirePlainRecord(transition, label);
  const expected = new Set([
    "transitionId",
    "token",
    "priorMode",
    "nextMode",
    "evidence",
    "evidenceHash",
    "preparedUtc",
    "preparedEventId",
    "preparedSequence",
  ]);
  if (!hasExactKeys(transition, expected)) {
    throw new TypeError(`${label} schema is invalid`);
  }
  validatePreparedMigrationPayload({
    transitionId: transition.transitionId,
    token: transition.token,
    priorMode: transition.priorMode,
    nextMode: transition.nextMode,
    evidence: transition.evidence,
    evidenceHash: transition.evidenceHash,
    preparedUtc: transition.preparedUtc,
  });
  requireMigrationUuid(
    transition.preparedEventId,
    "prepared migration event ID",
  );
  requireDistinctMigrationUuids(
    [
      ["migration transition ID", transition.transitionId],
      ["migration transition token", transition.token],
      ["prepared migration event ID", transition.preparedEventId],
    ],
    label,
  );
  for (const [identifierLabel, identifier] of [
    ["migration transition ID", transition.transitionId],
    ["migration transition token", transition.token],
    ["prepared migration event ID", transition.preparedEventId],
  ]) {
    if (
      migrationUuidSequence(identifier, identifierLabel) !==
      transition.preparedSequence
    ) {
      throw new TypeError(
        `${identifierLabel} sequence does not match preparation`,
      );
    }
  }
  if (
    !Number.isSafeInteger(transition.preparedSequence) ||
    transition.preparedSequence < 1 ||
    transition.preparedSequence > lastSequence
  ) {
    throw new TypeError("prepared migration sequence is invalid");
  }
  if (
    transition.evidence.journal.sequence !==
    transition.preparedSequence - 1
  ) {
    throw new TypeError(
      "prepared migration evidence sequence is incoherent",
    );
  }
}

function validateLastMigrationTransition(transition, lastSequence) {
  requirePlainRecord(transition, "last migration transition");
  if (!["committed", "aborted"].includes(transition.status)) {
    throw new TypeError("last migration transition status is invalid");
  }
  const expected = new Set([
    "transitionId",
    "token",
    "priorMode",
    "nextMode",
    "evidence",
    "evidenceHash",
    "preparedUtc",
    "preparedEventId",
    "preparedSequence",
    "status",
    "terminalEventId",
    "terminalSequence",
    "terminalUtc",
    ...(transition.status === "aborted" ? ["reason"] : []),
  ]);
  if (!hasExactKeys(transition, expected)) {
    throw new TypeError("last migration transition schema is invalid");
  }
  const pendingShape = {
    transitionId: transition.transitionId,
    token: transition.token,
    priorMode: transition.priorMode,
    nextMode: transition.nextMode,
    evidence: transition.evidence,
    evidenceHash: transition.evidenceHash,
    preparedUtc: transition.preparedUtc,
    preparedEventId: transition.preparedEventId,
    preparedSequence: transition.preparedSequence,
  };
  validatePendingMigrationTransition(
    pendingShape,
    lastSequence,
    "last migration transition preparation",
  );
  requireMigrationUuid(
    transition.terminalEventId,
    "terminal migration event ID",
  );
  requireDistinctMigrationUuids(
    [
      ["migration transition ID", transition.transitionId],
      ["migration transition token", transition.token],
      ["prepared migration event ID", transition.preparedEventId],
      ["terminal migration event ID", transition.terminalEventId],
    ],
    "last migration transition",
  );
  if (
    migrationUuidSequence(
      transition.terminalEventId,
      "terminal migration event ID",
    ) !== transition.terminalSequence
  ) {
    throw new TypeError(
      "terminal migration event ID sequence does not match termination",
    );
  }
  if (
    transition.terminalEventId === transition.preparedEventId ||
    !Number.isSafeInteger(transition.terminalSequence) ||
    transition.terminalSequence <= transition.preparedSequence ||
    (transition.status === "committed" &&
      transition.terminalSequence !==
        transition.preparedSequence + 1) ||
    transition.terminalSequence > lastSequence
  ) {
    throw new TypeError("terminal migration sequence is invalid");
  }
  requireSampleUtc(transition.terminalUtc, "migration terminal timestamp");
  if (transition.terminalUtc < transition.preparedUtc) {
    throw new TypeError(
      "migration terminal timestamp precedes its preparation",
    );
  }
  if (
    transition.status === "aborted" &&
    (typeof transition.reason !== "string" ||
      transition.reason.length < 1 ||
      transition.reason.length > 2_000)
  ) {
    throw new TypeError("migration abort reason is invalid");
  }
}

function validateMigrationState(migration, lastSequence, eventCounts) {
  requirePlainRecord(migration, "coordinator migration");
  const expected = new Set([
    "mode",
    "pendingTransition",
    "lastTransition",
  ]);
  if (
    !hasExactKeys(migration, expected) ||
    !MIGRATION_MODES.includes(migration.mode) ||
    (migration.pendingTransition !== null &&
      (typeof migration.pendingTransition !== "object" ||
        Array.isArray(migration.pendingTransition))) ||
    (migration.lastTransition !== null &&
      (typeof migration.lastTransition !== "object" ||
        Array.isArray(migration.lastTransition)))
  ) {
    throw new TypeError("coordinator migration state is invalid");
  }
  if (migration.pendingTransition !== null) {
    validatePendingMigrationTransition(
      migration.pendingTransition,
      lastSequence,
      "pending migration transition",
    );
    if (migration.pendingTransition.priorMode !== migration.mode) {
      throw new TypeError(
        "pending migration prior mode does not match coordinator mode",
      );
    }
  }
  if (migration.lastTransition !== null) {
    validateLastMigrationTransition(
      migration.lastTransition,
      lastSequence,
    );
    const retainedMode =
      migration.lastTransition.status === "committed"
        ? migration.lastTransition.nextMode
        : migration.lastTransition.priorMode;
    if (retainedMode !== migration.mode) {
      throw new TypeError(
        "last migration transition does not match coordinator mode",
      );
    }
  }
  if (
    migration.lastTransition === null &&
    migration.mode !== "legacy-active"
  ) {
    throw new TypeError(
      "non-legacy migration mode requires retained transition lineage",
    );
  }
  if (
    migration.pendingTransition !== null &&
    migration.lastTransition !== null
  ) {
    const pending = migration.pendingTransition;
    const last = migration.lastTransition;
    if (
      pending.preparedSequence <= last.terminalSequence ||
      pending.preparedUtc < last.terminalUtc
    ) {
      throw new TypeError(
        "pending migration transition precedes retained lineage",
      );
    }
    if (
      new Set([
        pending.transitionId.toLowerCase(),
        pending.token.toLowerCase(),
        pending.preparedEventId.toLowerCase(),
        last.transitionId.toLowerCase(),
        last.token.toLowerCase(),
        last.preparedEventId.toLowerCase(),
        last.terminalEventId.toLowerCase(),
      ]).size !== 7
    ) {
      throw new TypeError(
        "pending migration transition reuses retained identifiers",
      );
    }
  }

  const preparedCount =
    eventCounts["migration.transitionPrepared"] ?? 0;
  const committedCount =
    eventCounts["migration.transitionCommitted"] ?? 0;
  const abortedCount =
    eventCounts["migration.transitionAborted"] ?? 0;
  const terminalCount = committedCount + abortedCount;
  if (
    preparedCount !==
    terminalCount + (migration.pendingTransition === null ? 0 : 1)
  ) {
    throw new TypeError(
      "migration event counts contradict retained transition state",
    );
  }
  if (
    migration.lastTransition === null &&
    migration.pendingTransition === null &&
    terminalCount !== 0
  ) {
    throw new TypeError(
      "migration event counts require retained transition lineage",
    );
  }
  if (
    migration.lastTransition?.status === "committed" &&
    committedCount < 1
  ) {
    throw new TypeError(
      "committed migration lineage is absent from event counts",
    );
  }
  if (
    migration.lastTransition?.status === "aborted" &&
    abortedCount < 1
  ) {
    throw new TypeError(
      "aborted migration lineage is absent from event counts",
    );
  }
}

function validateEventCounts(eventCounts, lastSequence) {
  requirePlainRecord(eventCounts, "coordinator event counts");
  let total = 0;
  for (const [type, count] of Object.entries(eventCounts)) {
    if (
      !EVENT_TYPES.includes(type) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new TypeError("coordinator event counts are invalid");
    }
    total += count;
    if (!Number.isSafeInteger(total) || total > lastSequence) {
      throw new TypeError(
        "coordinator event counts exceed replay sequence history",
      );
    }
  }
}

function restoreCheckpoint(currentState, event) {
  const { state, stateHash, priorLastSequence } = event.payload;
  validateState(state);
  if (state.lastSequence !== priorLastSequence) {
    throw new Error("checkpoint prior sequence does not match embedded state");
  }
  if (hashCoordinatorState(state) !== stateHash) {
    throw new Error("checkpoint state hash does not match embedded state");
  }
  const expectedSequence = priorLastSequence + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(
      `checkpoint sequence must be ${expectedSequence}, received ${event.sequence}`,
    );
  }
  if (
    currentState.lastSequence !== 0 &&
    currentState.lastSequence !== priorLastSequence
  ) {
    throw new Error(
      "checkpoint cannot replace a different current replay sequence",
    );
  }
  const restored = structuredClone(state);
  restored.lastSequence = event.sequence;
  return restored;
}

function requireSampleIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/i.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(
      value.toLowerCase(),
    )
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function requireSampleUtc(value, label) {
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

function applyCommittedSample(next, payload) {
  const expectedKeys = new Set([
    "sensorId",
    "generationId",
    "startedUtc",
    "completedUtc",
    "durationMs",
    "providers",
  ]);
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== expectedKeys.size ||
    Object.keys(payload).some((key) => !expectedKeys.has(key)) ||
    payload.providers === null ||
    typeof payload.providers !== "object" ||
    Array.isArray(payload.providers)
  ) {
    throw new TypeError("committed sensor sample schema is invalid");
  }
  requireSampleIdentifier(payload.sensorId, "sensor ID");
  requireSampleIdentifier(payload.generationId, "sensor generation ID");
  const started = requireSampleUtc(
    payload.startedUtc,
    "sensor sample start",
  );
  const completed = requireSampleUtc(
    payload.completedUtc,
    "sensor sample completion",
  );
  if (
    completed < started ||
    !Number.isSafeInteger(payload.durationMs) ||
    payload.durationMs !== completed - started
  ) {
    throw new Error("committed sensor sample duration is invalid");
  }
  if (Object.keys(payload.providers).length > 100) {
    throw new RangeError("committed sensor sample has too many providers");
  }

  const sensor = Object.hasOwn(next.sensors, payload.sensorId)
    ? next.sensors[payload.sensorId]
    : {
        lastGenerationId: null,
        lastCompletedUtc: null,
        committedGenerations: {},
      };
  if (
    !Object.hasOwn(next.sensors, payload.sensorId) &&
    Object.keys(next.sensors).length >= MAX_SENSOR_COUNT
  ) {
    throw new RangeError("coordinator sensor state exceeds its bound");
  }
  if (Object.hasOwn(sensor.committedGenerations, payload.generationId)) {
    throw new Error(
      `sensor generation ${payload.generationId} is already committed`,
    );
  }
  if (
    sensor.lastCompletedUtc !== null &&
    completed < Date.parse(sensor.lastCompletedUtc)
  ) {
    throw new RangeError(
      "sensor sample completion cannot precede the last committed sample",
    );
  }
  const current = {};
  const lastKnownGood = Object.hasOwn(
    next.observations.lastKnownGood,
    payload.sensorId,
  )
    ? next.observations.lastKnownGood[payload.sensorId]
    : {};
  for (const providerId of Object.keys(payload.providers).sort()) {
    requireSampleIdentifier(providerId, "provider ID");
    const provider = payload.providers[providerId];
    const providerKeys = new Set([
      "status",
      "evidenceSha256",
      "byteLength",
      "truncated",
      "durationMs",
    ]);
    if (
      provider === null ||
      typeof provider !== "object" ||
      Array.isArray(provider) ||
      Object.keys(provider).some((key) => !providerKeys.has(key)) ||
      !["observed", "unavailable", "timed-out", "invalid"].includes(
        provider.status,
      ) ||
      typeof provider.evidenceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(provider.evidenceSha256) ||
      !Number.isSafeInteger(provider.byteLength) ||
      provider.byteLength < 0 ||
      typeof provider.truncated !== "boolean" ||
      (Object.hasOwn(provider, "durationMs") &&
        (!Number.isFinite(provider.durationMs) ||
          provider.durationMs < 0))
    ) {
      throw new TypeError(
        `committed provider ${providerId} schema is invalid`,
      );
    }
    const observation = {
      generationId: payload.generationId,
      status: provider.status,
      evidenceSha256: provider.evidenceSha256,
      byteLength: provider.byteLength,
      truncated: provider.truncated,
      observedUtc: payload.completedUtc,
      ...(Object.hasOwn(provider, "durationMs")
        ? { durationMs: provider.durationMs }
        : {}),
    };
    current[providerId] = observation;
    if (provider.status === "observed") {
      lastKnownGood[providerId] = structuredClone(observation);
    }
  }
  sensor.lastGenerationId = payload.generationId;
  sensor.lastCompletedUtc = payload.completedUtc;
  sensor.committedGenerations[payload.generationId] = payload.completedUtc;
  const protectedGenerationIds = new Set([
    payload.generationId,
    ...Object.values(current).map(
      (observation) => observation.generationId,
    ),
    ...Object.values(lastKnownGood).map(
      (observation) => observation.generationId,
    ),
  ]);
  const retainedGenerations = Object.entries(sensor.committedGenerations)
    .sort(([leftId, leftUtc], [rightId, rightUtc]) =>
      leftUtc.localeCompare(rightUtc) || leftId.localeCompare(rightId));
  while (
    retainedGenerations.length > MAX_RECENT_GENERATIONS_PER_SENSOR
  ) {
    const expiredIndex = retainedGenerations.findIndex(
      ([generationId]) => !protectedGenerationIds.has(generationId),
    );
    if (expiredIndex === -1) {
      throw new RangeError(
        "sensor observation generations exceed retained history bounds",
      );
    }
    const [[expiredGenerationId]] = retainedGenerations.splice(
      expiredIndex,
      1,
    );
    delete sensor.committedGenerations[expiredGenerationId];
  }
  next.sensors[payload.sensorId] = sensor;
  next.observations.current[payload.sensorId] = current;
  next.observations.lastKnownGood[payload.sensorId] = lastKnownGood;
}

function applyPreparedMigration(next, event) {
  validatePreparedMigrationPayload(event.payload);
  if (event.source !== "core.migration") {
    throw new Error("migration lifecycle event source is unauthorized");
  }
  if (event.sequence === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      "migration preparation must reserve terminal sequence capacity",
    );
  }
  if (next.migration.pendingTransition !== null) {
    throw new Error("migration journal contains overlapping pending transitions");
  }
  if (next.migration.mode !== event.payload.priorMode) {
    throw new Error("prepared migration prior mode drifted");
  }
  requireMigrationUuid(event.eventId, "prepared migration event ID");
  if (event.timestampUtc < event.payload.preparedUtc) {
    throw new Error(
      "prepared migration event timestamp precedes its payload",
    );
  }
  if (event.payload.evidence.journal.sequence !== event.sequence - 1) {
    throw new Error(
      "prepared migration evidence does not match the event sequence",
    );
  }
  const last = next.migration.lastTransition;
  if (
    last !== null &&
    (event.payload.transitionId === last.transitionId ||
      event.payload.token === last.token ||
      event.eventId === last.preparedEventId ||
      event.eventId === last.terminalEventId)
  ) {
    throw new Error(
      "prepared migration transition reuses retained identifiers",
    );
  }
  next.migration.pendingTransition = {
    transitionId: event.payload.transitionId,
    token: event.payload.token,
    priorMode: event.payload.priorMode,
    nextMode: event.payload.nextMode,
    evidence: structuredClone(event.payload.evidence),
    evidenceHash: event.payload.evidenceHash,
    preparedUtc: event.payload.preparedUtc,
    preparedEventId: event.eventId,
    preparedSequence: event.sequence,
  };
}

function applyTerminalMigration(next, event, status) {
  validateTerminalMigrationPayload(event.payload, status);
  if (event.source !== "core.migration") {
    throw new Error("migration lifecycle event source is unauthorized");
  }
  const pending = next.migration.pendingTransition;
  if (
    pending === null ||
    pending.transitionId !== event.payload.transitionId ||
    pending.token !== event.payload.token ||
    pending.preparedEventId !== event.payload.preparedEventId ||
    pending.priorMode !== event.payload.priorMode ||
    pending.nextMode !== event.payload.nextMode ||
    pending.evidenceHash !== event.payload.evidenceHash
  ) {
    throw new Error(`migration ${status} event has no matching prepare`);
  }
  requireMigrationUuid(event.eventId, "terminal migration event ID");
  if (
    event.eventId === pending.preparedEventId ||
    event.timestampUtc < pending.preparedUtc
  ) {
    throw new Error(
      "terminal migration event contradicts its preparation",
    );
  }
  const retained = next.migration.lastTransition;
  if (
    retained !== null &&
    (event.eventId === retained.preparedEventId ||
      event.eventId === retained.terminalEventId)
  ) {
    throw new Error(
      "terminal migration event reuses a retained event identifier",
    );
  }
  if (status === "committed") {
    next.migration.mode = pending.nextMode;
  }
  next.migration.lastTransition = {
    ...pending,
    status,
    terminalEventId: event.eventId,
    terminalSequence: event.sequence,
    terminalUtc: event.timestampUtc,
    ...(status === "aborted"
      ? { reason: event.payload.reason }
      : {}),
  };
  next.migration.pendingTransition = null;
}

export function reduceCoordinatorEvent(state, event) {
  validateState(state);
  validateEvent(event);
  if (
    !event.type.startsWith("migration.") &&
    MIGRATION_UUID_PATTERN_CASE_INSENSITIVE.test(event.eventId)
  ) {
    throw new Error(
      "migration UUID namespace is reserved for migration lifecycle events",
    );
  }

  if (event.type === "state.checkpoint") {
    return restoreCheckpoint(state, event);
  }

  const expectedSequence = state.lastSequence + 1;
  if (event.sequence !== expectedSequence) {
    throw new RangeError(
      `event sequence must be ${expectedSequence}, received ${event.sequence}`,
    );
  }

  const next = structuredClone(state);
  next.lastSequence = event.sequence;
  next.eventCounts[event.type] = (next.eventCounts[event.type] ?? 0) + 1;

  switch (event.type) {
    case "runtime.started":
      next.runtime.status = "running";
      next.runtime.generationId = event.payload.generationId ?? null;
      break;
    case "runtime.stopped":
      next.runtime.status = "stopped";
      break;
    case "runtime.degraded":
      next.runtime.health = "degraded-read-only";
      next.runtime.degradation = structuredClone(event.payload);
      break;
    case "runtime.recovered":
      if (next.runtime.health !== "degraded-read-only") {
        throw new Error(
          "runtime recovery requires degraded-read-only health",
        );
      }
      requirePlainRecord(event.payload, "runtime recovery payload");
      if (
        !hasExactKeys(
          event.payload,
          new Set(["probeId", "evidenceSha256"]),
        )
      ) {
        throw new TypeError(
          "runtime recovery requires an evidence-backed probe",
        );
      }
      requireSampleIdentifier(
        event.payload.probeId,
        "runtime recovery probe ID",
      );
      if (!/^[a-f0-9]{64}$/.test(event.payload.evidenceSha256)) {
        throw new TypeError("runtime recovery evidence SHA-256 is invalid");
      }
      next.runtime.health = "healthy";
      next.runtime.degradation = null;
      next.runtime.lastRecoveryProbeId = event.payload.probeId;
      break;
    case "sensor.sampleCommitted":
      applyCommittedSample(next, event.payload);
      break;
    case "migration.transitionPrepared":
      applyPreparedMigration(next, event);
      break;
    case "migration.transitionCommitted":
      applyTerminalMigration(next, event, "committed");
      break;
    case "migration.transitionAborted":
      applyTerminalMigration(next, event, "aborted");
      break;
    default:
      break;
  }

  validateState(next);
  return next;
}
