import { createHash } from "node:crypto";

import {
  SCHEMA_VERSION,
  canonicalJsonString,
  validateEvent,
} from "../contracts.mjs";

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
    value.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(value.lastSequence) ||
    value.lastSequence < 0
  ) {
    throw new TypeError("coordinator state is invalid");
  }
}

function restoreCheckpoint(event) {
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
  const restored = structuredClone(state);
  restored.lastSequence = event.sequence;
  return restored;
}

export function reduceCoordinatorEvent(state, event) {
  validateState(state);
  validateEvent(event);

  if (event.type === "state.checkpoint") {
    return restoreCheckpoint(event);
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
      next.runtime.health = "healthy";
      next.runtime.generationId = event.payload.generationId ?? null;
      next.runtime.degradation = null;
      break;
    case "runtime.stopped":
      next.runtime.status = "stopped";
      break;
    case "runtime.degraded":
      next.runtime.health = "degraded-read-only";
      next.runtime.degradation = structuredClone(event.payload);
      break;
    case "runtime.recovered":
      next.runtime.health = "healthy";
      next.runtime.degradation = null;
      next.runtime.lastRecoveryProbeId = event.payload.probeId ?? null;
      break;
    default:
      break;
  }

  return next;
}
