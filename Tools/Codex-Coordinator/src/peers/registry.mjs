import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  SCHEMA_VERSION,
  assertPeerId,
  canonicalJsonString,
  validateEvent,
} from "../contracts.mjs";

const REGISTRATION_KEYS = new Set([
  "peerId",
  "threadId",
  "label",
  "workspaceRoot",
  "codexVersion",
  "schemaHash",
]);
const REGISTRY_STATE_KEYS = new Set([
  "schemaVersion",
  "peers",
  "threadToPeer",
]);
const PEER_RECORD_KEYS = new Set([
  ...REGISTRATION_KEYS,
  "attachment",
  "registeredUtc",
]);
const ATTACHMENT_KEYS = new Set([
  "status",
  "appServerGeneration",
  "attachmentGeneration",
  "windowsBootId",
  "activeTurnId",
  "attachedUtc",
  "disconnectedUtc",
  "disconnectReason",
]);
const ATTACHMENT_EVENT_KEYS = new Set([
  "appServerGeneration",
  "attachmentGeneration",
  "windowsBootId",
  "activeTurnId",
  "attachedUtc",
]);
const CONNECTED_PAYLOAD_KEYS = new Set([
  "executablePath",
  "executableSha256",
  "pid",
  "parentPid",
  "creationTimeUtc",
  "endpoint",
  "supervisorGeneration",
  "appServerGeneration",
  "attachmentGeneration",
  "windowsBootId",
  "protocolSha256",
  "connectedUtc",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const RESERVED_IDENTIFIERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requirePlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.size ||
    actual.some((key) => !keys.has(key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function requireString(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !IDENTIFIER_PATTERN.test(value) ||
    RESERVED_IDENTIFIERS.has(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireBoundedString(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireUtc(value, label) {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be a UTC timestamp`);
  }
  return value;
}

function validateRegistration(value) {
  requirePlainObject(value, "peer registration");
  requireExactKeys(value, REGISTRATION_KEYS, "peer registration");
  assertPeerId(value.peerId);
  requireString(value.threadId, "thread ID", 128);
  requireBoundedString(value.label, "peer label", 128);
  if (
    typeof value.workspaceRoot !== "string" ||
    value.workspaceRoot.length === 0 ||
    value.workspaceRoot.length > 1024 ||
    !path.isAbsolute(value.workspaceRoot)
  ) {
    throw new TypeError("workspace root must be an absolute path");
  }
  if (
    typeof value.codexVersion !== "string" ||
    !SEMVER_PATTERN.test(value.codexVersion)
  ) {
    throw new TypeError("Codex version must be semantic version text");
  }
  if (
    typeof value.schemaHash !== "string" ||
    !SHA256_PATTERN.test(value.schemaHash)
  ) {
    throw new TypeError("schema hash must be lower-case SHA-256 text");
  }
  return structuredClone(value);
}

function validatePeerRecord(value, expectedPeerId) {
  requirePlainObject(value, "peer record");
  requireExactKeys(value, PEER_RECORD_KEYS, "peer record");
  const registration = {};
  for (const key of REGISTRATION_KEYS) {
    registration[key] = value[key];
  }
  validateRegistration(registration);
  if (value.peerId !== expectedPeerId) {
    throw new TypeError("peer record key and peer ID differ");
  }
  if (value.attachment !== "registered-unattached") {
    requirePlainObject(value.attachment, "peer attachment");
    requireExactKeys(
      value.attachment,
      ATTACHMENT_KEYS,
      "peer attachment",
    );
    if (
      !["attached", "reconcile-pending"].includes(
        value.attachment.status,
      )
    ) {
      throw new TypeError("peer attachment status is invalid");
    }
    requireString(
      value.attachment.appServerGeneration,
      "app-server generation",
      128,
    );
    requireString(
      value.attachment.attachmentGeneration,
      "attachment generation",
      128,
    );
    requireString(
      value.attachment.windowsBootId,
      "Windows boot ID",
      128,
    );
    if (value.attachment.activeTurnId !== null) {
      requireString(
        value.attachment.activeTurnId,
        "active turn ID",
        128,
      );
    }
    requireUtc(value.attachment.attachedUtc, "peer attachment time");
    if (value.attachment.status === "attached") {
      if (
        value.attachment.disconnectedUtc !== null ||
        value.attachment.disconnectReason !== null
      ) {
        throw new TypeError("attached peer has disconnect metadata");
      }
    } else {
      requireUtc(
        value.attachment.disconnectedUtc,
        "peer disconnect time",
      );
      requireString(
        value.attachment.disconnectReason,
        "peer disconnect reason",
        128,
      );
    }
  }
  requireUtc(value.registeredUtc, "peer registration time");
}

function createNullRecord() {
  return Object.create(null);
}

export function initialPeerRegistryState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    peers: {},
    threadToPeer: {},
  };
}

export function validatePeerRegistryState(value) {
  requirePlainObject(value, "peer registry state");
  requireExactKeys(value, REGISTRY_STATE_KEYS, "peer registry state");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError("peer registry schema version is invalid");
  }
  requirePlainObject(value.peers, "peer registry peers");
  requirePlainObject(value.threadToPeer, "peer registry thread index");
  const observedThreads = createNullRecord();
  for (const [key, record] of Object.entries(value.peers)) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(key)) {
      throw new TypeError("peer registry key is invalid");
    }
    const peerId = Number(key);
    assertPeerId(peerId);
    validatePeerRecord(record, peerId);
    if (Object.hasOwn(observedThreads, record.threadId)) {
      throw new TypeError("peer registry contains a duplicate thread ID");
    }
    observedThreads[record.threadId] = peerId;
  }
  const indexEntries = Object.entries(value.threadToPeer);
  if (indexEntries.length !== Object.keys(value.peers).length) {
    throw new TypeError("peer registry thread index is incomplete");
  }
  for (const [threadId, peerId] of indexEntries) {
    requireString(threadId, "thread ID", 128);
    assertPeerId(peerId);
    if (
      observedThreads[threadId] !== peerId ||
      value.peers[String(peerId)]?.threadId !== threadId
    ) {
      throw new TypeError("peer registry thread index is inconsistent");
    }
  }
  return value;
}

function validateRegisteredPayload(payload) {
  requirePlainObject(payload, "peer registration event payload");
  requireExactKeys(
    payload,
    new Set([...REGISTRATION_KEYS, "attachment", "registeredUtc"]),
    "peer registration event payload",
  );
  const registration = {};
  for (const key of REGISTRATION_KEYS) {
    registration[key] = payload[key];
  }
  validateRegistration(registration);
  if (payload.attachment !== "registered-unattached") {
    throw new TypeError("peer registration attachment is invalid");
  }
  requireUtc(payload.registeredUtc, "peer registration time");
}

function validateUnregisteredPayload(payload) {
  requirePlainObject(payload, "peer unregistration event payload");
  requireExactKeys(
    payload,
    new Set(["peerId", "threadId", "unregisteredUtc"]),
    "peer unregistration event payload",
  );
  assertPeerId(payload.peerId);
  requireString(payload.threadId, "thread ID", 128);
  requireUtc(payload.unregisteredUtc, "peer unregistration time");
}

function validateAttachedPayload(payload) {
  requirePlainObject(payload, "peer attachment event payload");
  requireExactKeys(
    payload,
    new Set(["peerId", "threadId", ...ATTACHMENT_EVENT_KEYS]),
    "peer attachment event payload",
  );
  assertPeerId(payload.peerId);
  requireString(payload.threadId, "thread ID", 128);
  requireString(
    payload.appServerGeneration,
    "app-server generation",
    128,
  );
  requireString(
    payload.attachmentGeneration,
    "attachment generation",
    128,
  );
  requireString(payload.windowsBootId, "Windows boot ID", 128);
  if (payload.activeTurnId !== null) {
    requireString(payload.activeTurnId, "active turn ID", 128);
  }
  requireUtc(payload.attachedUtc, "peer attachment time");
}

function validateDisconnectedPayload(payload) {
  requirePlainObject(payload, "app-server disconnected payload");
  requireExactKeys(
    payload,
    new Set([
      "appServerGeneration",
      "attachmentGeneration",
      "reason",
      "disconnectedUtc",
    ]),
    "app-server disconnected payload",
  );
  requireString(
    payload.appServerGeneration,
    "app-server generation",
    128,
  );
  requireString(
    payload.attachmentGeneration,
    "attachment generation",
    128,
  );
  requireString(payload.reason, "app-server disconnect reason", 128);
  requireUtc(payload.disconnectedUtc, "app-server disconnect time");
}

function validateConnectedPayload(payload) {
  requirePlainObject(payload, "app-server connected payload");
  requireExactKeys(
    payload,
    CONNECTED_PAYLOAD_KEYS,
    "app-server connected payload",
  );
  if (
    typeof payload.executablePath !== "string" ||
    !path.win32.isAbsolute(payload.executablePath)
  ) {
    throw new TypeError("app-server executable path is invalid");
  }
  if (
    !SHA256_PATTERN.test(payload.executableSha256) ||
    !SHA256_PATTERN.test(payload.protocolSha256)
  ) {
    throw new TypeError("app-server recorded SHA-256 is invalid");
  }
  if (
    !Number.isSafeInteger(payload.pid) ||
    payload.pid <= 0 ||
    !Number.isSafeInteger(payload.parentPid) ||
    payload.parentPid <= 0
  ) {
    throw new TypeError("app-server recorded PID is invalid");
  }
  requireUtc(payload.creationTimeUtc, "app-server creation time");
  requireUtc(payload.connectedUtc, "app-server connection time");
  if (
    typeof payload.endpoint !== "string" ||
    !/^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(payload.endpoint) ||
    Number(new URL(payload.endpoint).port) > 65_535
  ) {
    throw new TypeError("app-server loopback endpoint is invalid");
  }
  for (const [value, label] of [
    [payload.supervisorGeneration, "supervisor generation"],
    [payload.appServerGeneration, "app-server generation"],
    [payload.attachmentGeneration, "attachment generation"],
    [payload.windowsBootId, "Windows boot ID"],
  ]) {
    requireString(value, label, 128);
  }
}

export function reducePeerRegistryEvent(state, event) {
  validatePeerRegistryState(state);
  validateEvent(event);
  if (event.type === "state.checkpoint") {
    const checkpointRegistry = event.payload.state?.peers?.registry;
    validatePeerRegistryState(checkpointRegistry);
    return structuredClone(checkpointRegistry);
  }

  const next = structuredClone(state);
  if (event.type === "peer.registered") {
    validateRegisteredPayload(event.payload);
    const key = String(event.payload.peerId);
    if (Object.hasOwn(next.peers, key)) {
      throw new Error(`peer ${event.payload.peerId} is already registered`);
    }
    if (Object.hasOwn(next.threadToPeer, event.payload.threadId)) {
      throw new Error(
        `thread ${event.payload.threadId} is already registered`,
      );
    }
    next.peers[key] = structuredClone(event.payload);
    next.threadToPeer[event.payload.threadId] = event.payload.peerId;
  } else if (event.type === "appServer.connected") {
    validateConnectedPayload(event.payload);
  } else if (event.type === "peer.attached") {
    validateAttachedPayload(event.payload);
    const key = String(event.payload.peerId);
    const existing = next.peers[key];
    if (
      existing === undefined ||
      existing.threadId !== event.payload.threadId
    ) {
      throw new Error("peer attachment does not match active registry");
    }
    existing.attachment = {
      status: "attached",
      appServerGeneration: event.payload.appServerGeneration,
      attachmentGeneration: event.payload.attachmentGeneration,
      windowsBootId: event.payload.windowsBootId,
      activeTurnId: event.payload.activeTurnId,
      attachedUtc: event.payload.attachedUtc,
      disconnectedUtc: null,
      disconnectReason: null,
    };
  } else if (event.type === "appServer.disconnected") {
    validateDisconnectedPayload(event.payload);
    for (const peer of Object.values(next.peers)) {
      if (
        peer.attachment !== "registered-unattached" &&
        peer.attachment.appServerGeneration ===
          event.payload.appServerGeneration &&
        peer.attachment.attachmentGeneration ===
          event.payload.attachmentGeneration
      ) {
        peer.attachment.status = "reconcile-pending";
        peer.attachment.disconnectedUtc =
          event.payload.disconnectedUtc;
        peer.attachment.disconnectReason = event.payload.reason;
      }
    }
  } else if (event.type === "peer.unregistered") {
    validateUnregisteredPayload(event.payload);
    const key = String(event.payload.peerId);
    const existing = next.peers[key];
    if (
      existing === undefined ||
      existing.threadId !== event.payload.threadId
    ) {
      throw new Error("peer unregistration does not match active registry");
    }
    delete next.peers[key];
    delete next.threadToPeer[event.payload.threadId];
  }
  validatePeerRegistryState(next);
  return next;
}

export function reducePeerRegistryEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("peer registry events must be an array");
  }
  return events.reduce(
    (state, event) => reducePeerRegistryEvent(state, event),
    initialPeerRegistryState(),
  );
}

export function hashPeerRegistryState(state) {
  validatePeerRegistryState(state);
  return createHash("sha256")
    .update(canonicalJsonString(state, "peer registry state"), "utf8")
    .digest("hex");
}

function assertJournal(journal) {
  if (
    journal === null ||
    typeof journal !== "object" ||
    typeof journal.readFrom !== "function" ||
    typeof journal.append !== "function"
  ) {
    throw new TypeError("peer registry requires a durable journal");
  }
}

function assertClock(clock) {
  if (
    clock === null ||
    typeof clock !== "object" ||
    typeof clock.nowUtc !== "function"
  ) {
    throw new TypeError("peer registry requires an injected clock");
  }
}

function createEvent({ sequence, type, payload, clock, idFactory }) {
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    sequence,
    eventId: idFactory(),
    timestampUtc: clock.nowUtc(),
    source: "peers.registry",
    type,
    payload,
  };
  return validateEvent(candidate);
}

function isSequenceContention(error) {
  return (
    error instanceof RangeError &&
    /journal sequence must be/i.test(error.message)
  );
}

export async function reduceCoordinatorJournalEvents(events) {
  const {
    initialCoordinatorState,
    reduceCoordinatorEvent,
  } = await import("../core/reducer.mjs");
  return events.reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
}

export function assertPeerMutationAllowed(coordinatorState) {
  if (coordinatorState.runtime.health !== "healthy") {
    throw new Error(
      "peer mutations are disabled while runtime is degraded-read-only",
    );
  }
}

export async function preflightPeerMutation(coordinatorState, event) {
  const { reduceCoordinatorEvent } = await import("../core/reducer.mjs");
  return reduceCoordinatorEvent(coordinatorState, event);
}

function assertPeerHasNoOutstandingWork(peerState, peerId) {
  for (const message of Object.values(peerState.delivery.messages)) {
    if (
      message.status !== "acknowledged" &&
      (message.sourcePeerId === peerId || message.targetPeerId === peerId)
    ) {
      throw new Error(
        `peer ${peerId} has outstanding peer work and cannot be unregistered`,
      );
    }
  }
}

export function createPeerRegistry({
  journal,
  clock = {
    nowUtc: () => new Date().toISOString(),
  },
  idFactory = randomUUID,
}) {
  assertJournal(journal);
  assertClock(clock);
  if (typeof idFactory !== "function") {
    throw new TypeError("peer registry ID factory must be a function");
  }
  let mutationTail = Promise.resolve();

  function withMutation(operation) {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.catch(() => {});
    return pending;
  }

  async function readState() {
    return reducePeerRegistryEvents(await journal.readFrom(0));
  }

  async function registerPeer(value) {
    const registration = validateRegistration(value);
    return withMutation(async () => {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const events = await journal.readFrom(0);
        const coordinatorState = await reduceCoordinatorJournalEvents(events);
        assertPeerMutationAllowed(coordinatorState);
        const state = coordinatorState.peers.registry;
        const existing = state.peers[String(registration.peerId)];
        if (existing !== undefined) {
          if (existing.threadId === registration.threadId) {
            return {
              status: "already-registered",
              peer: structuredClone(existing),
            };
          }
          throw new Error(
            `peer ${registration.peerId} requires explicit unregister before replacement`,
          );
        }
        const threadOwner = state.threadToPeer[registration.threadId];
        if (threadOwner !== undefined) {
          throw new Error(
            `thread ${registration.threadId} is already registered to peer ${threadOwner}`,
          );
        }
        const registeredUtc = clock.nowUtc();
        requireUtc(registeredUtc, "peer registration time");
        const candidate = createEvent({
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          type: "peer.registered",
          payload: {
            ...registration,
            attachment: "registered-unattached",
            registeredUtc,
          },
          clock,
          idFactory,
        });
        reducePeerRegistryEvent(state, candidate);
        await preflightPeerMutation(coordinatorState, candidate);
        try {
          await journal.append(candidate, { flush: true });
          return {
            status: "registered",
            peer: structuredClone(candidate.payload),
          };
        } catch (error) {
          if (!isSequenceContention(error)) {
            throw error;
          }
        }
      }
      throw new Error("peer registration journal contention did not settle");
    });
  }

  async function unregisterPeer(peerId) {
    assertPeerId(peerId);
    return withMutation(async () => {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const events = await journal.readFrom(0);
        const coordinatorState = await reduceCoordinatorJournalEvents(events);
        assertPeerMutationAllowed(coordinatorState);
        const state = coordinatorState.peers.registry;
        const existing = state.peers[String(peerId)];
        if (existing === undefined) {
          throw new Error(`peer ${peerId} is not registered`);
        }
        assertPeerHasNoOutstandingWork(coordinatorState.peers, peerId);
        const unregisteredUtc = clock.nowUtc();
        requireUtc(unregisteredUtc, "peer unregistration time");
        const candidate = createEvent({
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          type: "peer.unregistered",
          payload: {
            peerId,
            threadId: existing.threadId,
            unregisteredUtc,
          },
          clock,
          idFactory,
        });
        reducePeerRegistryEvent(state, candidate);
        await preflightPeerMutation(coordinatorState, candidate);
        try {
          await journal.append(candidate, { flush: true });
          return {
            status: "unregistered",
            peerId,
            threadId: existing.threadId,
          };
        } catch (error) {
          if (!isSequenceContention(error)) {
            throw error;
          }
        }
      }
      throw new Error("peer unregistration journal contention did not settle");
    });
  }

  return Object.freeze({
    registerPeer,
    unregisterPeer,
    readState,
  });
}
