import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  SCHEMA_VERSION,
  assertPeerId,
  canonicalJsonString,
  validateEvent,
} from "../contracts.mjs";
import {
  assertPeerMutationAllowed,
  initialPeerRegistryState,
  preflightPeerMutation,
  reduceCoordinatorJournalEvents,
  reducePeerRegistryEvent,
  validatePeerRegistryState,
} from "./registry.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACKNOWLEDGED_RETENTION_MS = 7 * DAY_MS;
const DELIVERY_STATE_KEYS = new Set([
  "schemaVersion",
  "messages",
  "acknowledgements",
  "queues",
  "mailboxes",
  "conversations",
  "activeByTarget",
  "activeCount",
  "usage",
  "scheduler",
  "lastEventUtc",
]);
const PEER_STATE_KEYS = new Set(["schemaVersion", "registry", "delivery"]);
const MESSAGE_REQUIRED_KEYS = new Set([
  "sourcePeerId",
  "targetPeerId",
  "mode",
  "sourceKind",
  "text",
  "referencePaths",
  "authorityLabel",
  "clientDeduplicationKey",
  "hop",
]);
const MESSAGE_ALLOWED_KEYS = new Set([
  ...MESSAGE_REQUIRED_KEYS,
  "conversationId",
]);
const DELIVERY_MODES = new Set([
  "canonical",
  "material-sensor",
  "sidecar",
]);
const SOURCE_KINDS = new Set(["peer", "sensor"]);
const SCHEDULE = Object.freeze([
  "canonical",
  "canonical",
  "material-sensor",
  "canonical",
  "sidecar",
  "canonical",
  "material-sensor",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const RESERVED_IDENTIFIERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const DEFAULT_DELIVERY_LIMITS = Object.freeze({
  queuedMessagesPerPeer: 25,
  mailboxRecordsPerPeer: 100,
  activeTurnsPerTarget: 1,
  globalActiveTurns: 3,
  canonicalPerHour: 30,
  canonicalPerDay: 200,
  sidecarPerHour: 10,
  sidecarPerDay: 50,
  messageTextCharacters: 2_000,
  resultTextCharacters: 4_000,
  referencePaths: 5,
  automaticHops: 4,
  conversationTtlMs: 30 * 60 * 1000,
});
export const MAX_PEER_STATE_BYTES = 640 * 1024;
const RESERVED_COMPLETION_BYTES = 4_512;

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

function requireAllowedKeys(value, allowed, required, label) {
  const actual = Object.keys(value);
  if (
    actual.some((key) => !allowed.has(key)) ||
    [...required].some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function requireIdentifier(value, label, maxLength = 128) {
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

function requirePositiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizeLimits(overrides, limitsOwnerPeerId) {
  if (overrides === undefined) {
    return { ...DEFAULT_DELIVERY_LIMITS };
  }
  assertPeerId(limitsOwnerPeerId);
  if (limitsOwnerPeerId !== 0) {
    throw new Error("only peer 0 may change configured usage limits");
  }
  requirePlainObject(overrides, "delivery limits");
  const limits = { ...DEFAULT_DELIVERY_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_DELIVERY_LIMITS, key)) {
      throw new TypeError(`unknown delivery limit: ${key}`);
    }
    const normalized = requirePositiveLimit(value, `delivery limit ${key}`);
    if (
      ![
        "canonicalPerHour",
        "canonicalPerDay",
        "sidecarPerHour",
        "sidecarPerDay",
      ].includes(key) &&
      normalized > DEFAULT_DELIVERY_LIMITS[key]
    ) {
      throw new RangeError(
        `delivery limit ${key} exceeds its journal schema ceiling`,
      );
    }
    limits[key] = normalized;
  }
  return limits;
}

function createUsageState() {
  return {
    canonical: {
      peer: [],
      sensor: [],
    },
    sidecar: {
      peer: [],
      sensor: [],
    },
  };
}

export function initialPeerDeliveryState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    messages: {},
    acknowledgements: {},
    queues: {},
    mailboxes: {},
    conversations: {},
    activeByTarget: {},
    activeCount: 0,
    usage: createUsageState(),
    scheduler: {
      cursor: 0,
      lastClass: null,
      consecutive: 0,
    },
    lastEventUtc: null,
  };
}

export function initialPeerState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    registry: initialPeerRegistryState(),
    delivery: initialPeerDeliveryState(),
  };
}

function validateUsage(value) {
  requirePlainObject(value, "peer usage state");
  requireExactKeys(value, new Set(["canonical", "sidecar"]), "peer usage state");
  for (const mode of ["canonical", "sidecar"]) {
    requirePlainObject(value[mode], `${mode} usage`);
    requireExactKeys(
      value[mode],
      new Set(["peer", "sensor"]),
      `${mode} usage`,
    );
    for (const source of ["peer", "sensor"]) {
      if (!Array.isArray(value[mode][source])) {
        throw new TypeError(`${mode} ${source} usage must be an array`);
      }
      let prior = -Infinity;
      for (
        let index = 0;
        index < value[mode][source].length;
        index += 1
      ) {
        const timestamp = value[mode][source][index];
        requireUtc(timestamp, `${mode} ${source} usage timestamp`);
        const current = Date.parse(timestamp);
        if (current < prior) {
          throw new TypeError("peer usage timestamps are not monotonic");
        }
        prior = current;
      }
    }
  }
}

function validateDeliveryStateShape(value) {
  requirePlainObject(value, "peer delivery state");
  requireExactKeys(value, DELIVERY_STATE_KEYS, "peer delivery state");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError("peer delivery schema version is invalid");
  }
  for (const [label, record] of [
    ["messages", value.messages],
    ["acknowledgements", value.acknowledgements],
    ["queues", value.queues],
    ["mailboxes", value.mailboxes],
    ["conversations", value.conversations],
    ["active targets", value.activeByTarget],
  ]) {
    requirePlainObject(record, `peer delivery ${label}`);
  }
  if (!Number.isSafeInteger(value.activeCount) || value.activeCount < 0) {
    throw new TypeError("peer delivery active count is invalid");
  }
  if (Object.keys(value.activeByTarget).length !== value.activeCount) {
    throw new TypeError("peer delivery active count is inconsistent");
  }
  validateUsage(value.usage);
  requirePlainObject(value.scheduler, "peer scheduler state");
  requireExactKeys(
    value.scheduler,
    new Set(["cursor", "lastClass", "consecutive"]),
    "peer scheduler state",
  );
  if (
    !Number.isSafeInteger(value.scheduler.cursor) ||
    value.scheduler.cursor < 0 ||
    value.scheduler.cursor >= SCHEDULE.length ||
    !Number.isSafeInteger(value.scheduler.consecutive) ||
    value.scheduler.consecutive < 0 ||
    (value.scheduler.lastClass !== null &&
      !DELIVERY_MODES.has(value.scheduler.lastClass))
  ) {
    throw new TypeError("peer scheduler state is invalid");
  }
  if (value.lastEventUtc !== null) {
    requireUtc(value.lastEventUtc, "peer delivery last event time");
  }
}

function validateDeliveryRelations(value) {
  for (const [messageId, acknowledgement] of Object.entries(
    value.acknowledgements,
  )) {
    requireIdentifier(messageId, "acknowledged message ID");
    requirePlainObject(acknowledgement, "acknowledgement record");
    requireExactKeys(
      acknowledgement,
      new Set([
        "messageId",
        "sourcePeerId",
        "clientDeduplicationHash",
        "acknowledgedUtc",
      ]),
      "acknowledgement record",
    );
    if (
      acknowledgement.messageId !== messageId ||
      !SHA256_PATTERN.test(acknowledgement.clientDeduplicationHash)
    ) {
      throw new TypeError("acknowledgement identity is invalid");
    }
    assertPeerId(acknowledgement.sourcePeerId);
    requireUtc(
      acknowledgement.acknowledgedUtc,
      "acknowledgement retention time",
    );
  }
  const queued = new Set();
  for (const [targetKey, messageIds] of Object.entries(value.queues)) {
    assertPeerId(Number(targetKey));
    if (!Array.isArray(messageIds)) {
      throw new TypeError("peer target queue must be an array");
    }
    for (let index = 0; index < messageIds.length; index += 1) {
      const messageId = messageIds[index];
      requireIdentifier(messageId, "message ID");
      const message = value.messages[messageId];
      if (
        message === undefined ||
        message.status !== "queued" ||
        String(message.targetPeerId) !== targetKey ||
        queued.has(messageId)
      ) {
        throw new TypeError("peer target queue is inconsistent");
      }
      queued.add(messageId);
    }
  }
  for (const [messageId, message] of Object.entries(value.messages)) {
    requireIdentifier(messageId, "message ID");
    requirePlainObject(message, "message record");
    requireExactKeys(
      message,
      new Set([
        "messageId",
        "conversationId",
        ...MESSAGE_REQUIRED_KEYS,
        "enqueuedUtc",
        "conversationCreatedUtc",
        "conversationExpiresUtc",
        "status",
        "enqueuedSequence",
        "dispatchedUtc",
        "completedUtc",
        "result",
        "deliveryUnknownUtc",
        "deliveryUnknownReason",
        "acknowledgedUtc",
        "lastDeferred",
      ]),
      "message record",
    );
    if (message.messageId !== messageId || !DELIVERY_MODES.has(message.mode)) {
      throw new TypeError("message record identity or mode is invalid");
    }
    requireIdentifier(message.conversationId, "conversation ID");
    assertPeerId(message.sourcePeerId);
    assertPeerId(message.targetPeerId);
    if (!SOURCE_KINDS.has(message.sourceKind)) {
      throw new TypeError("message source kind is invalid");
    }
    if (
      ![
        "queued",
        "dispatching",
        "completed",
        "delivery-unknown",
      ].includes(message.status)
    ) {
      throw new TypeError("message status is invalid");
    }
    requireBoundedString(message.text, "message text", 2_000);
    if (
      !Array.isArray(message.referencePaths) ||
      message.referencePaths.length > 5
    ) {
      throw new TypeError("message reference paths are invalid");
    }
    requireBoundedString(message.authorityLabel, "authority label", 128);
    requireIdentifier(
      message.clientDeduplicationKey,
      "client deduplication key",
    );
    if (
      !Number.isSafeInteger(message.hop) ||
      message.hop < 0 ||
      message.hop > 4 ||
      !Number.isSafeInteger(message.enqueuedSequence) ||
      message.enqueuedSequence < 1
    ) {
      throw new TypeError("message chronology is invalid");
    }
    requireUtc(message.enqueuedUtc, "message enqueue time");
    requireUtc(
      message.conversationCreatedUtc,
      "conversation creation time",
    );
    requireUtc(
      message.conversationExpiresUtc,
      "conversation expiry time",
    );
    if (message.status === "dispatching") {
      requireUtc(message.dispatchedUtc, "message dispatch time");
    }
    if (message.status === "completed") {
      requireUtc(message.completedUtc, "message completion time");
      if (
        typeof message.result !== "string" ||
        message.result.length > 4_000
      ) {
        throw new TypeError("message result is invalid");
      }
    }
    if (message.status === "delivery-unknown") {
      requireUtc(message.deliveryUnknownUtc, "delivery unknown time");
      requireIdentifier(
        message.deliveryUnknownReason,
        "delivery unknown reason",
      );
    }
    if (message.lastDeferred !== null) {
      requirePlainObject(message.lastDeferred, "message deferral record");
      requireExactKeys(
        message.lastDeferred,
        new Set(["reason", "deadlineUtc", "deferredUtc"]),
        "message deferral record",
      );
      if (
        !["hour-budget", "day-budget"].includes(message.lastDeferred.reason)
      ) {
        throw new TypeError("message deferral reason is invalid");
      }
      requireUtc(message.lastDeferred.deadlineUtc, "message deferral deadline");
      requireUtc(message.lastDeferred.deferredUtc, "message deferral time");
    }
    if (message.status === "queued" && !queued.has(messageId)) {
      throw new TypeError("queued message is absent from its target queue");
    }
    if (value.conversations[message.conversationId] === undefined) {
      throw new TypeError("message conversation is absent");
    }
  }
  for (const [targetKey, messageId] of Object.entries(value.activeByTarget)) {
    assertPeerId(Number(targetKey));
    const message = value.messages[messageId];
    if (
      message === undefined ||
      message.status !== "dispatching" ||
      String(message.targetPeerId) !== targetKey
    ) {
      throw new TypeError("active target points to a non-dispatching message");
    }
  }
  for (const [ownerKey, records] of Object.entries(value.mailboxes)) {
    assertPeerId(Number(ownerKey));
    if (!Array.isArray(records)) {
      throw new TypeError("peer mailbox must be an array");
    }
    const seen = new Set();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      requirePlainObject(record, "mailbox record");
      requireExactKeys(
        record,
        new Set([
          "messageId",
          "ownerPeerId",
          "status",
          "availableUtc",
          "acknowledgedUtc",
        ]),
        "mailbox record",
      );
      if (
        record.ownerPeerId !== Number(ownerKey) ||
        seen.has(record.messageId) ||
        value.messages[record.messageId] === undefined ||
        !["available", "acknowledged"].includes(record.status)
      ) {
        throw new TypeError("mailbox record is inconsistent");
      }
      requireUtc(record.availableUtc, "mailbox availability time");
      if (record.status === "acknowledged") {
        requireUtc(record.acknowledgedUtc, "mailbox acknowledgement time");
      } else if (record.acknowledgedUtc !== null) {
        throw new TypeError("available mailbox record is acknowledged");
      }
      seen.add(record.messageId);
    }
  }
  for (const [conversationId, conversation] of Object.entries(
    value.conversations,
  )) {
    requireIdentifier(conversationId, "conversation ID");
    requirePlainObject(conversation, "conversation record");
    const required = new Set([
      "conversationId",
      "participants",
      "createdUtc",
      "expiresUtc",
      "status",
      "closeReason",
      "lastHop",
      "lastSourcePeerId",
      "lastTargetPeerId",
    ]);
    const allowed = new Set([...required, "closedUtc"]);
    requireAllowedKeys(
      conversation,
      allowed,
      required,
      "conversation record",
    );
    if (
      conversation.conversationId !== conversationId ||
      !Array.isArray(conversation.participants) ||
      conversation.participants.length !== 2
    ) {
      throw new TypeError("conversation identity or participants are invalid");
    }
    assertPeerId(conversation.participants[0]);
    assertPeerId(conversation.participants[1]);
    assertPeerId(conversation.lastSourcePeerId);
    assertPeerId(conversation.lastTargetPeerId);
    requireUtc(conversation.createdUtc, "conversation creation time");
    requireUtc(conversation.expiresUtc, "conversation expiry time");
    if (
      !Number.isSafeInteger(conversation.lastHop) ||
      conversation.lastHop < 0 ||
      conversation.lastHop > 4 ||
      !["open", "closed"].includes(conversation.status)
    ) {
      throw new TypeError("conversation status or hop is invalid");
    }
    if (conversation.status === "open") {
      if (
        conversation.closeReason !== null ||
        Object.hasOwn(conversation, "closedUtc")
      ) {
        throw new TypeError("open conversation contains close metadata");
      }
    } else {
      if (
        !["expired", "hop-limit"].includes(conversation.closeReason)
      ) {
        throw new TypeError("closed conversation reason is invalid");
      }
      requireUtc(conversation.closedUtc, "conversation close time");
    }
  }
}

export function validatePeerDeliveryState(value) {
  validateDeliveryStateShape(value);
  validateDeliveryRelations(value);
  return value;
}

export function validatePeerState(value) {
  requirePlainObject(value, "peer coordinator state");
  requireExactKeys(value, PEER_STATE_KEYS, "peer coordinator state");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError("peer coordinator schema version is invalid");
  }
  validatePeerRegistryState(value.registry);
  validatePeerDeliveryState(value.delivery);
  return value;
}

function maxUtc(current, candidate) {
  if (current === null || Date.parse(candidate) > Date.parse(current)) {
    return candidate;
  }
  return current;
}

function usageMode(mode) {
  return mode === "sidecar" ? "sidecar" : "canonical";
}

function hashClientDeduplicationKey(sourcePeerId, key) {
  return createHash("sha256")
    .update(`${sourcePeerId}\0${key}`, "utf8")
    .digest("hex");
}

function pruneUsage(usage, effectiveUtc) {
  const cutoff = Date.parse(effectiveUtc) - DAY_MS;
  for (const mode of ["canonical", "sidecar"]) {
    for (const source of ["peer", "sensor"]) {
      usage[mode][source] = Array.prototype.filter.call(
        usage[mode][source],
        (timestamp) => Date.parse(timestamp) > cutoff,
      );
    }
  }
}

function pruneAcknowledgedHistory(delivery, effectiveUtc) {
  const effectiveMs = Date.parse(effectiveUtc);
  const cutoff = effectiveMs - ACKNOWLEDGED_RETENTION_MS;
  for (const [ownerKey, records] of Object.entries(delivery.mailboxes)) {
    delivery.mailboxes[ownerKey] = Array.prototype.filter.call(
      records,
      (record) =>
        record.status !== "acknowledged" ||
        Date.parse(record.acknowledgedUtc) > cutoff,
    );
  }
  for (const [messageId, acknowledgement] of Object.entries(
    delivery.acknowledgements,
  )) {
    if (
      Date.parse(acknowledgement.acknowledgedUtc) <= cutoff
    ) {
      delete delivery.acknowledgements[messageId];
    }
  }
  const retainedConversations = new Set(
    Object.values(delivery.messages).map(
      (message) => message.conversationId,
    ),
  );
  for (const [conversationId, conversation] of Object.entries(
    delivery.conversations,
  )) {
    if (
      !retainedConversations.has(conversationId) &&
      Date.parse(conversation.expiresUtc) <= effectiveMs
    ) {
      delete delivery.conversations[conversationId];
    }
  }
}

function requireEnqueuedPayload(payload) {
  requirePlainObject(payload, "message enqueued payload");
  const keys = new Set([
    "messageId",
    "conversationId",
    ...MESSAGE_REQUIRED_KEYS,
    "enqueuedUtc",
    "conversationCreatedUtc",
    "conversationExpiresUtc",
  ]);
  requireExactKeys(payload, keys, "message enqueued payload");
  requireIdentifier(payload.messageId, "message ID");
  requireIdentifier(payload.conversationId, "conversation ID");
  assertPeerId(payload.sourcePeerId);
  assertPeerId(payload.targetPeerId);
  if (!DELIVERY_MODES.has(payload.mode) || !SOURCE_KINDS.has(payload.sourceKind)) {
    throw new TypeError("message mode or source kind is invalid");
  }
  requireBoundedString(payload.text, "message text", 2_000);
  if (
    !Array.isArray(payload.referencePaths) ||
    payload.referencePaths.length > 5 ||
    Array.prototype.some.call(
      payload.referencePaths,
      (reference) =>
        typeof reference !== "string" ||
        reference.length === 0 ||
        reference.length > 1024,
    )
  ) {
    throw new TypeError("message reference paths are invalid");
  }
  requireBoundedString(payload.authorityLabel, "authority label", 128);
  requireIdentifier(
    payload.clientDeduplicationKey,
    "client deduplication key",
  );
  if (
    !Number.isSafeInteger(payload.hop) ||
    payload.hop < 0 ||
    payload.hop > 4
  ) {
    throw new TypeError("message hop is invalid");
  }
  requireUtc(payload.enqueuedUtc, "message enqueue time");
  requireUtc(payload.conversationCreatedUtc, "conversation creation time");
  requireUtc(payload.conversationExpiresUtc, "conversation expiry time");
}

function applyEnqueued(next, event) {
  requireEnqueuedPayload(event.payload);
  const payload = event.payload;
  if (Object.hasOwn(next.messages, payload.messageId)) {
    throw new Error("message ID is already present");
  }
  const existingConversation = next.conversations[payload.conversationId];
  if (existingConversation === undefined) {
    next.conversations[payload.conversationId] = {
      conversationId: payload.conversationId,
      participants: [payload.sourcePeerId, payload.targetPeerId],
      createdUtc: payload.conversationCreatedUtc,
      expiresUtc: payload.conversationExpiresUtc,
      status: "open",
      closeReason: null,
      lastHop: payload.hop,
      lastSourcePeerId: payload.sourcePeerId,
      lastTargetPeerId: payload.targetPeerId,
    };
  } else {
    if (
      existingConversation.status !== "open" ||
      existingConversation.lastHop + 1 !== payload.hop ||
      existingConversation.lastSourcePeerId !== payload.targetPeerId ||
      existingConversation.lastTargetPeerId !== payload.sourcePeerId
    ) {
      throw new Error("message conversation chronology is invalid");
    }
    existingConversation.lastHop = payload.hop;
    existingConversation.lastSourcePeerId = payload.sourcePeerId;
    existingConversation.lastTargetPeerId = payload.targetPeerId;
  }
  next.messages[payload.messageId] = {
    ...structuredClone(payload),
    status: "queued",
    enqueuedSequence: event.sequence,
    dispatchedUtc: null,
    completedUtc: null,
    result: null,
    deliveryUnknownUtc: null,
    deliveryUnknownReason: null,
    acknowledgedUtc: null,
    lastDeferred: null,
  };
  const targetKey = String(payload.targetPeerId);
  next.queues[targetKey] ??= [];
  Array.prototype.push.call(next.queues[targetKey], payload.messageId);
}

function requireDispatchingPayload(payload) {
  requirePlainObject(payload, "message dispatching payload");
  requireExactKeys(
    payload,
    new Set(["messageId", "dispatchedUtc", "schedulerCursor"]),
    "message dispatching payload",
  );
  requireIdentifier(payload.messageId, "message ID");
  requireUtc(payload.dispatchedUtc, "message dispatch time");
  if (
    !Number.isSafeInteger(payload.schedulerCursor) ||
    payload.schedulerCursor < 0 ||
    payload.schedulerCursor >= SCHEDULE.length
  ) {
    throw new TypeError("message scheduler cursor is invalid");
  }
}

function applyDispatching(next, event) {
  requireDispatchingPayload(event.payload);
  const message = next.messages[event.payload.messageId];
  if (message?.status !== "queued") {
    throw new Error("message is not queued for dispatch");
  }
  const targetKey = String(message.targetPeerId);
  if (next.queues[targetKey]?.[0] !== message.messageId) {
    throw new Error("message dispatch violates target FIFO");
  }
  if (Object.hasOwn(next.activeByTarget, targetKey)) {
    throw new Error("message target already has an active turn");
  }
  Array.prototype.shift.call(next.queues[targetKey]);
  message.status = "dispatching";
  message.dispatchedUtc = event.payload.dispatchedUtc;
  message.lastDeferred = null;
  next.activeByTarget[targetKey] = message.messageId;
  next.activeCount += 1;
  const mode = usageMode(message.mode);
  Array.prototype.push.call(
    next.usage[mode][message.sourceKind],
    event.payload.dispatchedUtc,
  );
  const priorClass = next.scheduler.lastClass;
  next.scheduler.lastClass = message.mode;
  next.scheduler.consecutive =
    priorClass === message.mode ? next.scheduler.consecutive + 1 : 1;
  next.scheduler.cursor = event.payload.schedulerCursor;
}

function requireCompletedPayload(payload) {
  requirePlainObject(payload, "message completed payload");
  requireExactKeys(
    payload,
    new Set([
      "messageId",
      "result",
      "completedUtc",
      "mailboxPeerId",
    ]),
    "message completed payload",
  );
  requireIdentifier(payload.messageId, "message ID");
  requireBoundedString(payload.result, "result text", 4_000);
  requireUtc(payload.completedUtc, "message completion time");
  assertPeerId(payload.mailboxPeerId);
}

function applyCompleted(next, event) {
  requireCompletedPayload(event.payload);
  const message = next.messages[event.payload.messageId];
  if (
    message?.status !== "dispatching" ||
    message.sourcePeerId !== event.payload.mailboxPeerId
  ) {
    throw new Error("message is not dispatching for this mailbox owner");
  }
  const targetKey = String(message.targetPeerId);
  if (next.activeByTarget[targetKey] !== message.messageId) {
    throw new Error("message active target ownership is inconsistent");
  }
  delete next.activeByTarget[targetKey];
  next.activeCount -= 1;
  message.status = "completed";
  message.result = event.payload.result;
  message.completedUtc = event.payload.completedUtc;
  const ownerKey = String(event.payload.mailboxPeerId);
  next.mailboxes[ownerKey] ??= [];
  Array.prototype.push.call(next.mailboxes[ownerKey], {
    messageId: message.messageId,
    ownerPeerId: event.payload.mailboxPeerId,
    status: "available",
    availableUtc: event.payload.completedUtc,
    acknowledgedUtc: null,
  });
}

function applyDeliveryUnknown(next, event) {
  const payload = event.payload;
  requirePlainObject(payload, "delivery unknown payload");
  requireExactKeys(
    payload,
    new Set(["messageId", "mailboxPeerId", "reason", "unknownUtc"]),
    "delivery unknown payload",
  );
  requireIdentifier(payload.messageId, "message ID");
  assertPeerId(payload.mailboxPeerId);
  requireIdentifier(payload.reason, "delivery unknown reason");
  requireUtc(payload.unknownUtc, "delivery unknown time");
  const message = next.messages[payload.messageId];
  if (
    message?.status !== "dispatching" ||
    message.sourcePeerId !== payload.mailboxPeerId
  ) {
    throw new Error("message is not dispatching for this mailbox owner");
  }
  const targetKey = String(message.targetPeerId);
  if (next.activeByTarget[targetKey] !== message.messageId) {
    throw new Error("message active target ownership is inconsistent");
  }
  delete next.activeByTarget[targetKey];
  next.activeCount -= 1;
  message.status = "delivery-unknown";
  message.deliveryUnknownUtc = payload.unknownUtc;
  message.deliveryUnknownReason = payload.reason;
  const ownerKey = String(payload.mailboxPeerId);
  next.mailboxes[ownerKey] ??= [];
  Array.prototype.push.call(next.mailboxes[ownerKey], {
    messageId: message.messageId,
    ownerPeerId: payload.mailboxPeerId,
    status: "available",
    availableUtc: payload.unknownUtc,
    acknowledgedUtc: null,
  });
}

function applyDeferred(next, event) {
  const payload = event.payload;
  requirePlainObject(payload, "message failed payload");
  requireExactKeys(
    payload,
    new Set([
      "messageId",
      "status",
      "reason",
      "deadlineUtc",
      "deferredUtc",
    ]),
    "message failed payload",
  );
  requireIdentifier(payload.messageId, "message ID");
  if (
    payload.status !== "deferred" ||
    !["hour-budget", "day-budget"].includes(payload.reason)
  ) {
    throw new TypeError("message deferred result is invalid");
  }
  requireUtc(payload.deadlineUtc, "message deferral deadline");
  requireUtc(payload.deferredUtc, "message deferral time");
  const message = next.messages[payload.messageId];
  if (message?.status !== "queued") {
    throw new Error("only a queued message may be deferred");
  }
  message.lastDeferred = {
    reason: payload.reason,
    deadlineUtc: payload.deadlineUtc,
    deferredUtc: payload.deferredUtc,
  };
}

function applyAcknowledged(next, event) {
  const payload = event.payload;
  requirePlainObject(payload, "message acknowledgement payload");
  requireExactKeys(
    payload,
    new Set(["messageId", "peerId", "acknowledgedUtc"]),
    "message acknowledgement payload",
  );
  requireIdentifier(payload.messageId, "message ID");
  assertPeerId(payload.peerId);
  requireUtc(payload.acknowledgedUtc, "message acknowledgement time");
  const mailbox = next.mailboxes[String(payload.peerId)] ?? [];
  const recordIndex = Array.prototype.findIndex.call(
    mailbox,
    (item) => item.messageId === payload.messageId,
  );
  const record = recordIndex < 0 ? undefined : mailbox[recordIndex];
  const message = next.messages[payload.messageId];
  if (
    record === undefined ||
    record.status !== "available" ||
    message?.status !== "completed"
  ) {
    throw new Error("message is not available for acknowledgement");
  }
  next.acknowledgements[payload.messageId] = {
    messageId: payload.messageId,
    sourcePeerId: message.sourcePeerId,
    clientDeduplicationHash: hashClientDeduplicationKey(
      message.sourcePeerId,
      message.clientDeduplicationKey,
    ),
    acknowledgedUtc: payload.acknowledgedUtc,
  };
  Array.prototype.splice.call(mailbox, recordIndex, 1);
  delete next.messages[payload.messageId];
}

function applyConversationClosed(next, event) {
  const payload = event.payload;
  requirePlainObject(payload, "conversation closed payload");
  requireExactKeys(
    payload,
    new Set(["conversationId", "reason", "closedUtc"]),
    "conversation closed payload",
  );
  requireIdentifier(payload.conversationId, "conversation ID");
  if (!["expired", "hop-limit"].includes(payload.reason)) {
    throw new TypeError("conversation close reason is invalid");
  }
  requireUtc(payload.closedUtc, "conversation close time");
  const conversation = next.conversations[payload.conversationId];
  if (conversation === undefined || conversation.status !== "open") {
    throw new Error("conversation is not open");
  }
  conversation.status = "closed";
  conversation.closeReason = payload.reason;
  conversation.closedUtc = payload.closedUtc;
}

export function reducePeerDeliveryEvent(state, event) {
  validatePeerDeliveryState(state);
  validateEvent(event);
  if (event.type === "state.checkpoint") {
    const checkpointDelivery = event.payload.state?.peers?.delivery;
    validatePeerDeliveryState(checkpointDelivery);
    return structuredClone(checkpointDelivery);
  }
  const next = structuredClone(state);
  next.lastEventUtc = maxUtc(next.lastEventUtc, event.timestampUtc);
  pruneUsage(next.usage, next.lastEventUtc);
  pruneAcknowledgedHistory(next, next.lastEventUtc);
  switch (event.type) {
    case "message.enqueued":
      applyEnqueued(next, event);
      break;
    case "message.dispatching":
      applyDispatching(next, event);
      break;
    case "message.completed":
      applyCompleted(next, event);
      break;
    case "message.deliveryUnknown":
      applyDeliveryUnknown(next, event);
      break;
    case "message.failed":
      applyDeferred(next, event);
      break;
    case "message.acknowledged":
      applyAcknowledged(next, event);
      break;
    case "conversation.closed":
      applyConversationClosed(next, event);
      break;
    default:
      break;
  }
  validatePeerDeliveryState(next);
  return next;
}

export function reducePeerEvent(state, event) {
  validatePeerState(state);
  validateEvent(event);
  if (event.type === "state.checkpoint") {
    const checkpointPeers = event.payload.state?.peers;
    validatePeerState(checkpointPeers);
    return structuredClone(checkpointPeers);
  }
  const next = {
    schemaVersion: SCHEMA_VERSION,
    registry: reducePeerRegistryEvent(state.registry, event),
    delivery: reducePeerDeliveryEvent(state.delivery, event),
  };
  validatePeerState(next);
  return next;
}

export function reducePeerEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("peer events must be an array");
  }
  return events.reduce(
    (state, event) => reducePeerEvent(state, event),
    initialPeerState(),
  );
}

export function hashPeerDeliveryState(state) {
  validatePeerDeliveryState(state);
  return createHash("sha256")
    .update(canonicalJsonString(state, "peer delivery state"), "utf8")
    .digest("hex");
}

function assertJournal(journal) {
  if (
    journal === null ||
    typeof journal !== "object" ||
    typeof journal.readFrom !== "function" ||
    typeof journal.append !== "function"
  ) {
    throw new TypeError("peer delivery requires a durable journal");
  }
}

function assertClock(clock) {
  if (
    clock === null ||
    typeof clock !== "object" ||
    typeof clock.nowUtc !== "function" ||
    typeof clock.nowMonotonic !== "function"
  ) {
    throw new TypeError("peer delivery requires UTC and monotonic clocks");
  }
}

function validateMessageInput(value, limits) {
  requirePlainObject(value, "peer message");
  requireAllowedKeys(
    value,
    MESSAGE_ALLOWED_KEYS,
    MESSAGE_REQUIRED_KEYS,
    "peer message",
  );
  assertPeerId(value.sourcePeerId);
  assertPeerId(value.targetPeerId);
  if (value.sourcePeerId === value.targetPeerId) {
    throw new TypeError("peer message source and target must differ");
  }
  if (!DELIVERY_MODES.has(value.mode)) {
    throw new TypeError("peer message mode is invalid");
  }
  if (!SOURCE_KINDS.has(value.sourceKind)) {
    throw new TypeError("peer message source kind is invalid");
  }
  if (
    (value.mode === "material-sensor") !==
    (value.sourceKind === "sensor")
  ) {
    throw new TypeError("peer message mode and source kind are inconsistent");
  }
  requireBoundedString(
    value.text,
    "message text",
    limits.messageTextCharacters,
  );
  if (
    !Array.isArray(value.referencePaths) ||
    value.referencePaths.length > limits.referencePaths
  ) {
    throw new TypeError("message reference paths exceed their limit");
  }
  for (const reference of value.referencePaths) {
    if (
      typeof reference !== "string" ||
      reference.length === 0 ||
      reference.length > 1024 ||
      !path.isAbsolute(reference)
    ) {
      throw new TypeError("message reference path is invalid");
    }
  }
  requireBoundedString(value.authorityLabel, "authority label", 128);
  requireIdentifier(
    value.clientDeduplicationKey,
    "client deduplication key",
  );
  if (!Number.isSafeInteger(value.hop) || value.hop < 0) {
    throw new TypeError("message hop is invalid");
  }
  if (Object.hasOwn(value, "conversationId")) {
    requireIdentifier(value.conversationId, "conversation ID");
  }
  return structuredClone(value);
}

function createEvent({ sequence, type, payload, clock, idFactory }) {
  return validateEvent({
    schemaVersion: SCHEMA_VERSION,
    sequence,
    eventId: idFactory(),
    timestampUtc: clock.nowUtc(),
    source: "peers.delivery",
    type,
    payload,
  });
}

function isSequenceContention(error) {
  return (
    error instanceof RangeError &&
    /journal sequence must be/i.test(error.message)
  );
}

function findDuplicate(delivery, input) {
  const message = Object.values(delivery.messages).find(
    (message) =>
      message.sourcePeerId === input.sourcePeerId &&
      message.clientDeduplicationKey === input.clientDeduplicationKey,
  );
  if (message !== undefined) {
    return message;
  }
  const expectedHash = hashClientDeduplicationKey(
    input.sourcePeerId,
    input.clientDeduplicationKey,
  );
  const acknowledgement = Object.values(delivery.acknowledgements).find(
    (record) =>
      record.sourcePeerId === input.sourcePeerId &&
      record.clientDeduplicationHash === expectedHash,
  );
  return acknowledgement === undefined
    ? undefined
    : {
        messageId: acknowledgement.messageId,
        sourcePeerId: acknowledgement.sourcePeerId,
        clientDeduplicationKey: input.clientDeduplicationKey,
        status: "acknowledged",
        acknowledgedUtc: acknowledgement.acknowledgedUtc,
      };
}

function hasConversationWork(delivery, conversationId) {
  return Object.values(delivery.messages).some(
    (message) =>
      message.conversationId === conversationId &&
      ["queued", "dispatching"].includes(message.status),
  );
}

function countAvailableMailboxRecords(delivery, peerId) {
  return Array.prototype.filter.call(
    delivery.mailboxes[String(peerId)] ?? [],
    (record) => record.status === "available",
  ).length;
}

function countReservedMailboxRecords(delivery, peerId) {
  return Object.values(delivery.messages).filter(
    (message) =>
      message.sourcePeerId === peerId &&
      ["queued", "dispatching"].includes(message.status),
  ).length;
}

function peerStateBytesWithCompletionReservations(peerState) {
  const outstanding = Object.values(peerState.delivery.messages).filter(
    (message) => ["queued", "dispatching"].includes(message.status),
  ).length;
  return (
    Buffer.byteLength(
      canonicalJsonString(peerState, "peer checkpoint state"),
      "utf8",
    ) +
    outstanding * RESERVED_COMPLETION_BYTES
  );
}

function nextScheduleChoice(delivery, candidates) {
  const byMode = new Map();
  for (const candidate of candidates) {
    const existing = byMode.get(candidate.mode);
    if (
      existing === undefined ||
      candidate.enqueuedSequence < existing.enqueuedSequence
    ) {
      byMode.set(candidate.mode, candidate);
    }
  }
  let allowedModes = new Set(byMode.keys());
  if (
    delivery.scheduler.consecutive >= 2 &&
    allowedModes.size > 1 &&
    allowedModes.has(delivery.scheduler.lastClass)
  ) {
    allowedModes.delete(delivery.scheduler.lastClass);
  }
  for (let offset = 0; offset < SCHEDULE.length; offset += 1) {
    const index = (delivery.scheduler.cursor + offset) % SCHEDULE.length;
    const mode = SCHEDULE[index];
    if (allowedModes.has(mode)) {
      return {
        message: byMode.get(mode),
        schedulerCursor: (index + 1) % SCHEDULE.length,
      };
    }
  }
  const message = [...byMode.values()].sort(
    (left, right) => left.enqueuedSequence - right.enqueuedSequence,
  )[0];
  return {
    message,
    schedulerCursor: delivery.scheduler.cursor,
  };
}

function budgetValues(limits, mode) {
  if (usageMode(mode) === "sidecar") {
    return {
      hourly: limits.sidecarPerHour,
      daily: limits.sidecarPerDay,
    };
  }
  return {
    hourly: limits.canonicalPerHour,
    daily: limits.canonicalPerDay,
  };
}

function canStartFromState(delivery, limits, mode, source, nowMs) {
  if (!DELIVERY_MODES.has(mode)) {
    throw new TypeError("usage mode is invalid");
  }
  if (!SOURCE_KINDS.has(source)) {
    throw new TypeError("usage source is invalid");
  }
  const normalizedMode = usageMode(mode);
  const all = [
    ...Array.prototype.slice.call(
      delivery.usage[normalizedMode].peer,
    ),
    ...Array.prototype.slice.call(
      delivery.usage[normalizedMode].sensor,
    ),
  ]
    .map((timestamp) => Date.parse(timestamp))
    .sort((left, right) => left - right);
  const hourly = all.filter((timestamp) => timestamp > nowMs - HOUR_MS);
  const daily = all.filter((timestamp) => timestamp > nowMs - DAY_MS);
  const budget = budgetValues(limits, mode);
  const sourceCounts = {
    peer: Array.prototype.filter.call(
      delivery.usage[normalizedMode].peer,
      (timestamp) => Date.parse(timestamp) > nowMs - DAY_MS,
    ).length,
    sensor: Array.prototype.filter.call(
      delivery.usage[normalizedMode].sensor,
      (timestamp) => Date.parse(timestamp) > nowMs - DAY_MS,
    ).length,
  };
  if (daily.length >= budget.daily) {
    return {
      allowed: false,
      reason: "day-budget",
      deadlineUtc: new Date(daily[0] + DAY_MS).toISOString(),
      sourceCounts,
    };
  }
  if (hourly.length >= budget.hourly) {
    return {
      allowed: false,
      reason: "hour-budget",
      deadlineUtc: new Date(hourly[0] + HOUR_MS).toISOString(),
      sourceCounts,
    };
  }
  return {
    allowed: true,
    reason: null,
    deadlineUtc: null,
    sourceCounts,
  };
}

export function createPeerDelivery({
  journal,
  clock = {
    nowUtc: () => new Date().toISOString(),
    nowMonotonic: () => performance.now(),
  },
  idFactory = randomUUID,
  limits: limitOverrides,
  limitsOwnerPeerId = 0,
}) {
  assertJournal(journal);
  assertClock(clock);
  if (typeof idFactory !== "function") {
    throw new TypeError("peer delivery ID factory must be a function");
  }
  const limits = normalizeLimits(limitOverrides, limitsOwnerPeerId);
  let mutationTail = Promise.resolve();
  let lastEffectiveUtcMs = -Infinity;
  const clockAnchor = {
    utcMs: Date.parse(clock.nowUtc()),
    monotonicMs: clock.nowMonotonic(),
  };
  const conversationDeadlines = new Map();

  function effectiveNow(state) {
    const wallMs = Date.parse(clock.nowUtc());
    const eventMs =
      state.delivery.lastEventUtc === null
        ? -Infinity
        : Date.parse(state.delivery.lastEventUtc);
    const monotonicMs =
      clockAnchor.utcMs + (clock.nowMonotonic() - clockAnchor.monotonicMs);
    lastEffectiveUtcMs = Math.max(
      lastEffectiveUtcMs,
      wallMs,
      eventMs,
      monotonicMs,
    );
    return lastEffectiveUtcMs;
  }

  function conversationExpired(state, conversation) {
    const wallMs = Date.parse(clock.nowUtc());
    const lastEventMs =
      state.delivery.lastEventUtc === null
        ? -Infinity
        : Date.parse(state.delivery.lastEventUtc);
    if (wallMs < lastEventMs) {
      return true;
    }
    const nowMonotonic = clock.nowMonotonic();
    let deadline = conversationDeadlines.get(conversation.conversationId);
    if (deadline === undefined) {
      const remaining = Math.max(
        0,
        Date.parse(conversation.expiresUtc) - effectiveNow(state),
      );
      deadline = nowMonotonic + remaining;
      conversationDeadlines.set(conversation.conversationId, deadline);
    }
    return nowMonotonic >= deadline || effectiveNow(state) >=
      Date.parse(conversation.expiresUtc);
  }

  function withMutation(operation) {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.catch(() => {});
    return pending;
  }

  async function readState() {
    return reducePeerEvents(await journal.readFrom(0));
  }

  async function appendWithRetry(buildCandidate) {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const events = await journal.readFrom(0);
      const coordinatorState = await reduceCoordinatorJournalEvents(events);
      const state = coordinatorState.peers;
      const built = await buildCandidate(events, state);
      if (built.event === null) {
        return built.result;
      }
      assertPeerMutationAllowed(coordinatorState);
      reducePeerEvent(state, built.event);
      await preflightPeerMutation(coordinatorState, built.event);
      try {
        await journal.append(built.event, { flush: true });
        return built.result;
      } catch (error) {
        if (!isSequenceContention(error)) {
          throw error;
        }
      }
    }
    throw new Error("peer delivery journal contention did not settle");
  }

  async function closeConversation(conversationId, reason) {
    return appendWithRetry(async (events, state) => {
      const conversation = state.delivery.conversations[conversationId];
      if (conversation?.status === "closed") {
        return {
          event: null,
          result: {
            status: "conversation-closed",
            reason: conversation.closeReason,
            conversationId,
          },
        };
      }
      const closedUtc = new Date(effectiveNow(state)).toISOString();
      const event = createEvent({
        sequence: (events.at(-1)?.sequence ?? 0) + 1,
        type: "conversation.closed",
        payload: {
          conversationId,
          reason,
          closedUtc,
        },
        clock,
        idFactory,
      });
      return {
        event,
        result: {
          status: "conversation-closed",
          reason,
          conversationId,
        },
      };
    });
  }

  async function enqueueMessage(value) {
    const input = validateMessageInput(value, limits);
    return withMutation(async () =>
      appendWithRetry(async (events, state) => {
        const registry = state.registry;
        if (registry.peers[String(input.sourcePeerId)] === undefined) {
          throw new Error(`source peer ${input.sourcePeerId} is not registered`);
        }
        if (registry.peers[String(input.targetPeerId)] === undefined) {
          throw new Error(`target peer ${input.targetPeerId} is not registered`);
        }
        const duplicate = findDuplicate(state.delivery, input);
        if (duplicate !== undefined) {
          return {
            event: null,
            result: {
              status: "duplicate",
              message: structuredClone(duplicate),
            },
          };
        }
        const mailboxLoad =
          countAvailableMailboxRecords(
            state.delivery,
            input.sourcePeerId,
          ) +
          countReservedMailboxRecords(
            state.delivery,
            input.sourcePeerId,
          );
        if (mailboxLoad >= limits.mailboxRecordsPerPeer) {
          return {
            event: null,
            result: {
              status: "backpressure",
              reason: "source-mailbox-full",
              sourcePeerId: input.sourcePeerId,
            },
          };
        }
        const queue =
          state.delivery.queues[String(input.targetPeerId)] ?? [];
        if (queue.length >= limits.queuedMessagesPerPeer) {
          return {
            event: null,
            result: {
              status: "backpressure",
              reason: "target-queue-full",
              targetPeerId: input.targetPeerId,
            },
          };
        }

        let conversationId = input.conversationId;
        let conversationCreatedUtc;
        let conversationExpiresUtc;
        let createdConversation = false;
        if (conversationId === undefined) {
          if (input.hop !== 0) {
            throw new Error("a new conversation must start at hop zero");
          }
          conversationId = idFactory();
          requireIdentifier(conversationId, "conversation ID");
          conversationCreatedUtc = new Date(effectiveNow(state)).toISOString();
          conversationExpiresUtc = new Date(
            Date.parse(conversationCreatedUtc) + limits.conversationTtlMs,
          ).toISOString();
          conversationDeadlines.set(
            conversationId,
            clock.nowMonotonic() + limits.conversationTtlMs,
          );
          createdConversation = true;
        } else {
          const conversation =
            state.delivery.conversations[conversationId];
          if (conversation === undefined) {
            throw new Error(`conversation ${conversationId} is not registered`);
          }
          if (conversation.status === "closed") {
            return {
              event: null,
              result: {
                status: "conversation-closed",
                reason: conversation.closeReason,
                conversationId,
              },
            };
          }
          if (conversationExpired(state, conversation)) {
            return {
              event: null,
              result: await closeConversation(conversationId, "expired"),
            };
          }
          if (input.hop > limits.automaticHops) {
            return {
              event: null,
              result: await closeConversation(conversationId, "hop-limit"),
            };
          }
          if (hasConversationWork(state.delivery, conversationId)) {
            throw new Error(
              "conversation already has queued or active work",
            );
          }
          if (
            input.hop !== conversation.lastHop + 1 ||
            input.sourcePeerId !== conversation.lastTargetPeerId ||
            input.targetPeerId !== conversation.lastSourcePeerId
          ) {
            throw new Error("conversation direction or hop is invalid");
          }
          conversationCreatedUtc = conversation.createdUtc;
          conversationExpiresUtc = conversation.expiresUtc;
        }

        const enqueuedUtc = new Date(effectiveNow(state)).toISOString();
        const messageId = idFactory();
        requireIdentifier(messageId, "message ID");
        const event = createEvent({
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          type: "message.enqueued",
          payload: {
            messageId,
            conversationId,
            ...input,
            enqueuedUtc,
            conversationCreatedUtc,
            conversationExpiresUtc,
          },
          clock,
          idFactory,
        });
        const next = reducePeerEvent(state, event);
        if (
          peerStateBytesWithCompletionReservations(next) >
          MAX_PEER_STATE_BYTES
        ) {
          if (createdConversation) {
            conversationDeadlines.delete(conversationId);
          }
          return {
            event: null,
            result: {
              status: "backpressure",
              reason: "peer-state-capacity",
            },
          };
        }
        return {
          event,
          result: {
            status: "enqueued",
            message: structuredClone(
              next.delivery.messages[messageId],
            ),
          },
        };
      }),
    );
  }

  async function appendDeferral(events, state, message, gate) {
    if (
      message.lastDeferred?.reason === gate.reason &&
      message.lastDeferred?.deadlineUtc === gate.deadlineUtc
    ) {
      return {
        event: null,
        result: {
          status: "deferred",
          reason: gate.reason,
          deadlineUtc: gate.deadlineUtc,
          messageId: message.messageId,
        },
      };
    }
    const deferredUtc = new Date(effectiveNow(state)).toISOString();
    const event = createEvent({
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      type: "message.failed",
      payload: {
        messageId: message.messageId,
        status: "deferred",
        reason: gate.reason,
        deadlineUtc: gate.deadlineUtc,
        deferredUtc,
      },
      clock,
      idFactory,
    });
    return {
      event,
      result: {
        status: "deferred",
        reason: gate.reason,
        deadlineUtc: gate.deadlineUtc,
        messageId: message.messageId,
      },
    };
  }

  async function claimNextMessage(peerId) {
    if (peerId !== undefined) {
      assertPeerId(peerId);
    }
    return withMutation(async () =>
      appendWithRetry(async (events, state) => {
        if (
          peerId !== undefined &&
          state.registry.peers[String(peerId)] === undefined
        ) {
          throw new Error(`target peer ${peerId} is not registered`);
        }
        if (state.delivery.activeCount >= limits.globalActiveTurns) {
          return {
            event: null,
            result: {
              status: "blocked",
              reason: "global-active-limit",
            },
          };
        }
        if (
          peerId !== undefined &&
          Object.hasOwn(state.delivery.activeByTarget, String(peerId))
        ) {
          return {
            event: null,
            result: {
              status: "blocked",
              reason: "target-active",
            },
          };
        }
        const candidates = [];
        for (const [targetKey, queue] of Object.entries(
          state.delivery.queues,
        )) {
          if (
            queue.length === 0 ||
            Object.hasOwn(state.delivery.activeByTarget, targetKey) ||
            (peerId !== undefined && Number(targetKey) !== peerId) ||
            state.registry.peers[targetKey] === undefined
          ) {
            continue;
          }
          candidates.push(state.delivery.messages[queue[0]]);
        }
        if (candidates.length === 0) {
          return {
            event: null,
            result: {
              status: "empty",
            },
          };
        }
        const nowMs = effectiveNow(state);
        const allowed = [];
        const denied = [];
        for (const candidate of candidates) {
          const gate = canStartFromState(
            state.delivery,
            limits,
            candidate.mode,
            candidate.sourceKind,
            nowMs,
          );
          (gate.allowed ? allowed : denied).push({
            message: candidate,
            gate,
          });
        }
        if (allowed.length === 0) {
          const oldest = denied.sort(
            (left, right) =>
              left.message.enqueuedSequence -
              right.message.enqueuedSequence,
          )[0];
          return appendDeferral(
            events,
            state,
            oldest.message,
            oldest.gate,
          );
        }
        const choice = nextScheduleChoice(
          state.delivery,
          allowed.map((item) => item.message),
        );
        const dispatchedUtc = new Date(nowMs).toISOString();
        const event = createEvent({
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          type: "message.dispatching",
          payload: {
            messageId: choice.message.messageId,
            dispatchedUtc,
            schedulerCursor: choice.schedulerCursor,
          },
          clock,
          idFactory,
        });
        const next = reducePeerEvent(state, event);
        return {
          event,
          result: {
            status: "dispatching",
            message: structuredClone(
              next.delivery.messages[choice.message.messageId],
            ),
          },
        };
      }),
    );
  }

  async function completeMessage(messageId, result) {
    requireIdentifier(messageId, "message ID");
    requireBoundedString(
      result,
      "result text",
      limits.resultTextCharacters,
    );
    return withMutation(async () =>
      appendWithRetry(async (events, state) => {
        const message = state.delivery.messages[messageId];
        if (message?.status !== "dispatching") {
          throw new Error(`message ${messageId} is not dispatching`);
        }
        if (
          countAvailableMailboxRecords(
            state.delivery,
            message.sourcePeerId,
          ) >= limits.mailboxRecordsPerPeer
        ) {
          throw new Error("source mailbox capacity was not reserved");
        }
        const completedUtc = new Date(effectiveNow(state)).toISOString();
        const event = createEvent({
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          type: "message.completed",
          payload: {
            messageId,
            result,
            completedUtc,
            mailboxPeerId: message.sourcePeerId,
          },
          clock,
          idFactory,
        });
        return {
          event,
          result: {
            status: "completed",
            messageId,
            mailboxPeerId: message.sourcePeerId,
          },
        };
      }),
    );
  }

  async function ackMessage(messageId, peerId) {
    requireIdentifier(messageId, "message ID");
    assertPeerId(peerId);
    return withMutation(async () =>
      appendWithRetry(async (events, state) => {
        const acknowledgement =
          state.delivery.acknowledgements[messageId];
        if (acknowledgement !== undefined) {
          if (acknowledgement.sourcePeerId !== peerId) {
            throw new Error(`peer ${peerId} is not the mailbox owner`);
          }
          return {
            event: null,
            result: {
              status: "already-acknowledged",
              messageId,
              peerId,
            },
          };
        }
        const mailbox =
          state.delivery.mailboxes[String(peerId)] ?? [];
        const record = Array.prototype.find.call(
          mailbox,
          (item) => item.messageId === messageId,
        );
        if (record === undefined) {
          const owner = Object.entries(state.delivery.mailboxes).find(
            ([, records]) =>
              Array.prototype.some.call(
                records,
                (item) => item.messageId === messageId,
              ),
          )?.[0];
          if (owner !== undefined) {
            throw new Error(`peer ${peerId} is not the mailbox owner`);
          }
          throw new Error(`message ${messageId} is not in a mailbox`);
        }
        const acknowledgedUtc = new Date(effectiveNow(state)).toISOString();
        const event = createEvent({
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          type: "message.acknowledged",
          payload: {
            messageId,
            peerId,
            acknowledgedUtc,
          },
          clock,
          idFactory,
        });
        return {
          event,
          result: {
            status: "acknowledged",
            messageId,
            peerId,
          },
        };
      }),
    );
  }

  const usage = Object.freeze({
    async canStart({ mode, source }) {
      const state = await readState();
      return canStartFromState(
        state.delivery,
        limits,
        mode,
        source,
        effectiveNow(state),
      );
    },
  });

  return Object.freeze({
    enqueueMessage,
    claimNextMessage,
    completeMessage,
    ackMessage,
    readState,
    usage,
    limits: Object.freeze({ ...limits }),
  });
}
