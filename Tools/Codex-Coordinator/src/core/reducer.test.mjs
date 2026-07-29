import assert from "node:assert/strict";
import test from "node:test";

import {
  hashCoordinatorState,
  initialCoordinatorState,
  reduceCoordinatorEvent,
  stableStringify,
} from "./reducer.mjs";

function event(sequence, type, payload = {}) {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `reducer-${sequence}`,
    timestampUtc: `2026-07-28T00:00:0${sequence}.000Z`,
    source: "reducer-test",
    type,
    payload,
  };
}

test("reducer replay is pure and deterministic", () => {
  const initial = initialCoordinatorState();
  const original = structuredClone(initial);
  const started = reduceCoordinatorEvent(
    initial,
    event(1, "runtime.started", { generationId: "runtime-1" }),
  );
  const degraded = reduceCoordinatorEvent(
    started,
    event(2, "runtime.degraded", { reason: "disk-full" }),
  );
  const recovered = reduceCoordinatorEvent(
    degraded,
    event(3, "runtime.recovered", { probeId: "probe-1" }),
  );

  assert.deepEqual(initial, original);
  assert.equal(started.runtime.health, "healthy");
  assert.equal(started.runtime.generationId, "runtime-1");
  assert.equal(degraded.runtime.health, "degraded-read-only");
  assert.equal(recovered.runtime.health, "healthy");
  assert.equal(recovered.lastSequence, 3);
  assert.equal(
    hashCoordinatorState(recovered),
    hashCoordinatorState(structuredClone(recovered)),
  );
});

test("reducer rejects sequence gaps outside a checkpoint", () => {
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(2, "runtime.started"),
      ),
    /sequence.*1/i,
  );
});

test("reducer checkpoint replay verifies and restores logical state", () => {
  const state = reduceCoordinatorEvent(
    initialCoordinatorState(),
    event(1, "runtime.started", { generationId: "runtime-1" }),
  );
  const checkpoint = event(2, "state.checkpoint", {
    state,
    stateHash: hashCoordinatorState(state),
    priorLastSequence: 1,
  });
  const restored = reduceCoordinatorEvent(initialCoordinatorState(), checkpoint);
  assert.equal(hashCoordinatorState(restored), hashCoordinatorState(state));
  assert.equal(restored.lastSequence, 2);

  assert.throws(
    () =>
      reduceCoordinatorEvent(initialCoordinatorState(), {
        ...checkpoint,
        payload: { ...checkpoint.payload, stateHash: "0".repeat(64) },
      }),
    /checkpoint.*hash/i,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(initialCoordinatorState(), {
        ...checkpoint,
        sequence: 999,
      }),
    /checkpoint.*sequence|expected.*2/i,
  );
});

test("reducer state hashing rejects non-JSON state", () => {
  const withMap = initialCoordinatorState();
  withMap.runtime.extra = new Map([["value", 1]]);
  assert.throws(() => hashCoordinatorState(withMap), /plain|JSON/i);
});

test("reducer canonical serialization ignores inherited toJSON hooks", () => {
  const state = initialCoordinatorState();
  const expected = stableStringify(state);
  Object.defineProperty(Object.prototype, "toJSON", {
    value() {
      return null;
    },
    configurable: true,
  });
  try {
    assert.equal(stableStringify(state), expected);
    assert.equal(
      hashCoordinatorState(state),
      hashCoordinatorState(initialCoordinatorState()),
    );
  } finally {
    delete Object.prototype.toJSON;
  }
});
