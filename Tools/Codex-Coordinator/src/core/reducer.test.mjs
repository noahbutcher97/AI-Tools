import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalJsonString,
  validateEvent,
} from "../contracts.mjs";
import {
  createMigrationUuid,
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

function migrationEvent(sequence, eventId, type, payload) {
  return {
    ...event(sequence, type, payload),
    eventId,
    source: "core.migration",
  };
}

function sha256Json(value) {
  return createHash("sha256")
    .update(canonicalJsonString(value), "utf8")
    .digest("hex");
}

const MIGRATION_SHA_A = "a".repeat(64);
const MIGRATION_SHA_B = "b".repeat(64);
const MIGRATION_SHA_C = "c".repeat(64);
const MIGRATION_BOOT_ID = "windows-boot-2026-07-28-a";

function migrationOwnerForMode(mode) {
  return ["legacy-active", "shadow-observe", "cutover-prepared"].includes(
    mode,
  )
    ? "legacy"
    : "unified";
}

function migrationProcessIdentity(name, pid) {
  return {
    generationId: `${name}-generation-1`,
    pid,
    creationTimeUtc: "2026-07-28T00:00:00.000Z",
    executablePath: `C:\\Coordinator\\${name}.exe`,
    bootId: MIGRATION_BOOT_ID,
  };
}

function migrationEvidence(priorMode, nextMode, sequence = 0) {
  return {
    schemaVersion: 1,
    windowsBootId: MIGRATION_BOOT_ID,
    processes: {
      supervisor: migrationProcessIdentity("supervisor", 4101),
      legacy: migrationProcessIdentity("legacy", 4102),
    },
    eventFile: {
      byteLength: 107,
      cursor: 96,
      remainder: "{\"partial\":",
      fingerprintSha256: MIGRATION_SHA_A,
    },
    journal: {
      sequence,
      checkpointSha256: MIGRATION_SHA_B,
    },
    routingOwnership: {
      priorOwners: [migrationOwnerForMode(priorMode)],
      nextOwners: [migrationOwnerForMode(nextMode)],
    },
    compatibilityOutputOwnership: {
      priorOwners: [migrationOwnerForMode(priorMode)],
      nextOwners: [migrationOwnerForMode(nextMode)],
    },
    appServer: {
      generationId: "app-server-generation-1",
      pid: 4103,
      creationTimeUtc: "2026-07-28T00:00:00.000Z",
      executablePath: "C:\\Coordinator\\codex-app-server.exe",
      bootId: MIGRATION_BOOT_ID,
      attachmentGeneration: "attachment-generation-1",
    },
    rollbackBoundary: {
      eventCursor: 96,
      eventFingerprintSha256: MIGRATION_SHA_A,
      frozenLegacyConfigSha256: MIGRATION_SHA_C,
    },
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
    event(3, "runtime.recovered", {
      probeId: "probe-1",
      evidenceSha256: "a".repeat(64),
    }),
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

test("runtime start preserves degraded health until verified recovery", () => {
  const degraded = reduceCoordinatorEvent(
    initialCoordinatorState(),
    event(1, "runtime.degraded", { reason: "disk-full" }),
  );
  const restarted = reduceCoordinatorEvent(
    degraded,
    event(2, "runtime.started", { generationId: "runtime-2" }),
  );

  assert.equal(restarted.runtime.status, "running");
  assert.equal(restarted.runtime.generationId, "runtime-2");
  assert.equal(restarted.runtime.health, "degraded-read-only");
  assert.deepEqual(restarted.runtime.degradation, { reason: "disk-full" });
});

test("runtime recovery requires an evidence-backed probe", () => {
  const degraded = reduceCoordinatorEvent(
    initialCoordinatorState(),
    event(1, "runtime.degraded", { reason: "disk-full" }),
  );

  for (const payload of [
    {},
    { probeId: "probe-1" },
    { probeId: "probe-1", evidenceSha256: "not-a-hash" },
    { probeId: "constructor", evidenceSha256: "a".repeat(64) },
  ]) {
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          degraded,
          event(2, "runtime.recovered", payload),
        ),
      /recovery|probe|evidence/i,
    );
  }
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(1, "runtime.recovered", {
          probeId: "probe-without-degradation",
          evidenceSha256: "a".repeat(64),
        }),
      ),
    /degraded|recovery/i,
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

test("reducer rejects a structurally incomplete checkpoint state", () => {
  const malformedState = {
    schemaVersion: 1,
    lastSequence: 0,
  };
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(1, "state.checkpoint", {
          state: malformedState,
          stateHash: hashCoordinatorState(malformedState),
          priorLastSequence: 0,
        }),
      ),
    /coordinator state.*invalid/i,
  );
});

test("reducer rejects malformed nested checkpoint branches", () => {
  for (const mutate of [
    (state) => {
      state.alerts["bad-alert"] = [];
    },
    (state) => {
      state.migration.pendingTransition = [];
    },
    (state) => {
      state.migration.lastTransition = { unexpected: true };
    },
  ]) {
    const malformedState = initialCoordinatorState();
    mutate(malformedState);
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          event(1, "state.checkpoint", {
            state: malformedState,
            stateHash: hashCoordinatorState(malformedState),
            priorLastSequence: 0,
          }),
        ),
      /coordinator state|alerts|migration.*invalid/i,
    );
  }
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

test("reducer projects only committed samples and preserves last-known-good", () => {
  const observed = reduceCoordinatorEvent(
    initialCoordinatorState(),
    event(1, "sensor.sampleCommitted", {
      sensorId: "combat-lane",
      generationId: "g-1",
      startedUtc: "2026-07-28T00:00:00.000Z",
      completedUtc: "2026-07-28T00:00:01.000Z",
      durationMs: 1_000,
      providers: {
        p4: {
          status: "observed",
          evidenceSha256: "a".repeat(64),
          byteLength: 42,
          truncated: false,
        },
      },
    }),
  );
  const unavailable = reduceCoordinatorEvent(
    observed,
    event(2, "sensor.sampleCommitted", {
      sensorId: "combat-lane",
      generationId: "g-2",
      startedUtc: "2026-07-28T00:01:00.000Z",
      completedUtc: "2026-07-28T00:01:01.000Z",
      durationMs: 1_000,
      providers: {
        p4: {
          status: "unavailable",
          evidenceSha256: "b".repeat(64),
          byteLength: 39,
          truncated: false,
        },
      },
    }),
  );

  assert.equal(
    unavailable.observations.current["combat-lane"].p4.status,
    "unavailable",
  );
  assert.equal(
    unavailable.observations.lastKnownGood["combat-lane"].p4.evidenceSha256,
    "a".repeat(64),
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        unavailable,
        event(3, "sensor.sampleCommitted", {
          sensorId: "combat-lane",
          generationId: "g-1",
          startedUtc: "2026-07-28T00:02:00.000Z",
          completedUtc: "2026-07-28T00:02:01.000Z",
          durationMs: 1_000,
          providers: {},
        }),
      ),
    /generation.*already committed|duplicate/i,
  );
});

test("reducer rejects prototype-key sample identifiers", () => {
  const payload = {
    sensorId: "constructor",
    generationId: "g-1",
    startedUtc: "2026-07-28T00:00:00.000Z",
    completedUtc: "2026-07-28T00:00:01.000Z",
    durationMs: 1_000,
    providers: {},
  };

  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(1, "sensor.sampleCommitted", payload),
      ),
    /sensor ID.*invalid/i,
  );

  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(1, "sensor.sampleCommitted", {
          ...payload,
          sensorId: "combat-lane",
          providers: {
            prototype: {
              status: "observed",
              evidenceSha256: "a".repeat(64),
              byteLength: 42,
              truncated: false,
            },
          },
        }),
      ),
    /provider ID.*invalid/i,
  );
});

test("reducer bounds generation dedupe state below checkpoint limits", () => {
  let state = initialCoordinatorState();
  for (let index = 1; index <= 2_000; index += 1) {
    state = reduceCoordinatorEvent(state, {
      schemaVersion: 1,
      sequence: index,
      eventId: `bounded-generation-${index}`,
      timestampUtc: "2026-07-28T00:00:00.000Z",
      source: "reducer-test",
      type: "sensor.sampleCommitted",
      payload: {
        sensorId: "combat-lane",
        generationId: `generation-${index}`,
        startedUtc: "2026-07-28T00:00:00.000Z",
        completedUtc: "2026-07-28T00:00:01.000Z",
        durationMs: 1_000,
        providers: {},
      },
    });
  }

  assert.equal(
    Object.keys(state.sensors["combat-lane"].committedGenerations).length <=
      128,
    true,
  );
  assert.doesNotThrow(() =>
    validateEvent({
      schemaVersion: 1,
      sequence: 2_001,
      eventId: "bounded-checkpoint",
      timestampUtc: "2026-07-28T00:00:02.000Z",
      source: "reducer-test",
      type: "state.checkpoint",
      payload: {
        state,
        stateHash: hashCoordinatorState(state),
        priorLastSequence: 2_000,
      },
    }),
  );
});

test("reducer rejects aggregate state beyond the checkpoint byte budget", () => {
  const state = initialCoordinatorState();
  for (let sensorIndex = 0; sensorIndex < 100; sensorIndex += 1) {
    const sensorId = `sensor-${sensorIndex}`;
    const committedGenerations = {};
    for (let generationIndex = 0; generationIndex < 128; generationIndex += 1) {
      const prefix = `g-${sensorIndex}-${generationIndex}-`;
      const generationId = `${prefix}${"x".repeat(128 - prefix.length)}`;
      committedGenerations[generationId] =
        "2026-07-28T00:00:01.000Z";
    }
    const generationIds = Object.keys(committedGenerations);
    state.sensors[sensorId] = {
      lastGenerationId: generationIds.at(-1),
      lastCompletedUtc: "2026-07-28T00:00:01.000Z",
      committedGenerations,
    };
    state.observations.current[sensorId] = {};
    state.observations.lastKnownGood[sensorId] = {};
  }

  assert.throws(
    () =>
      reduceCoordinatorEvent(
        state,
        event(1, "runtime.started", { generationId: "runtime-1" }),
      ),
    /checkpoint.*byte budget|state.*byte bound/i,
  );
});

test("reducer rejects non-monotonic checkpoint generation history", () => {
  for (const mutate of [
    (state) => {
      state.sensors["combat-lane"] = {
        lastGenerationId: "g-latest",
        lastCompletedUtc: "2026-07-28T00:00:02.000Z",
        committedGenerations: {
          "g-latest": "2026-07-28T00:00:02.000Z",
          "g-future": "2026-07-28T00:00:03.000Z",
        },
      };
      state.observations.current["combat-lane"] = {};
      state.observations.lastKnownGood["combat-lane"] = {};
    },
    (state) => {
      state.sensors["combat-lane"] = {
        lastGenerationId: null,
        lastCompletedUtc: null,
        committedGenerations: {
          orphan: "2026-07-28T00:00:01.000Z",
        },
      };
      state.observations.current["combat-lane"] = {};
      state.observations.lastKnownGood["combat-lane"] = {};
    },
  ]) {
    const malformedState = initialCoordinatorState();
    mutate(malformedState);
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          event(1, "state.checkpoint", {
            state: malformedState,
            stateHash: hashCoordinatorState(malformedState),
            priorLastSequence: 0,
          }),
        ),
      /generation|completion|history/i,
    );
  }
});

test("reducer rejects incoherent checkpoint observations", () => {
  for (const mutate of [
    (state) => {
      state.observations.lastKnownGood["combat-lane"].p4.status =
        "unavailable";
    },
    (state) => {
      state.observations.current["combat-lane"].p4.generationId =
        "g-orphan";
    },
    (state) => {
      state.observations.current["combat-lane"].p4.observedUtc =
        "2026-07-28T00:00:03.000Z";
    },
  ]) {
    const malformedState = reduceCoordinatorEvent(
      initialCoordinatorState(),
      event(1, "sensor.sampleCommitted", {
        sensorId: "combat-lane",
        generationId: "g-latest",
        startedUtc: "2026-07-28T00:00:00.000Z",
        completedUtc: "2026-07-28T00:00:01.000Z",
        durationMs: 1_000,
        providers: {
          p4: {
            status: "observed",
            evidenceSha256: "a".repeat(64),
            byteLength: 42,
            truncated: false,
          },
        },
      }),
    );
    mutate(malformedState);
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          event(2, "state.checkpoint", {
            state: malformedState,
            stateHash: hashCoordinatorState(malformedState),
            priorLastSequence: 1,
          }),
        ),
      /observation|generation|last-known-good|completion/i,
    );
  }

  const first = reduceCoordinatorEvent(
    initialCoordinatorState(),
    event(1, "sensor.sampleCommitted", {
      sensorId: "combat-lane",
      generationId: "g-first",
      startedUtc: "2026-07-28T00:00:00.000Z",
      completedUtc: "2026-07-28T00:00:01.000Z",
      durationMs: 1_000,
      providers: {
        p4: {
          status: "observed",
          evidenceSha256: "a".repeat(64),
          byteLength: 42,
          truncated: false,
        },
      },
    }),
  );
  const latest = reduceCoordinatorEvent(
    first,
    event(2, "sensor.sampleCommitted", {
      sensorId: "combat-lane",
      generationId: "g-latest",
      startedUtc: "2026-07-28T00:00:01.000Z",
      completedUtc: "2026-07-28T00:00:02.000Z",
      durationMs: 1_000,
      providers: {
        p4: {
          status: "observed",
          evidenceSha256: "b".repeat(64),
          byteLength: 43,
          truncated: false,
        },
      },
    }),
  );
  for (const mutate of [
    (state) => {
      state.observations.lastKnownGood["combat-lane"].p4 =
        structuredClone(
          first.observations.lastKnownGood["combat-lane"].p4,
        );
    },
    (state) => {
      delete state.observations.lastKnownGood["combat-lane"].p4;
    },
  ]) {
    const malformedState = structuredClone(latest);
    mutate(malformedState);
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          event(3, "state.checkpoint", {
            state: malformedState,
            stateHash: hashCoordinatorState(malformedState),
            priorLastSequence: 2,
          }),
        ),
      /last-known-good|observation/i,
    );
  }
});

test("reducer projects migration ownership into checkpoint state", () => {
  const evidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
  );
  const evidenceHash = sha256Json(evidence);
  const transitionId = createMigrationUuid(1);
  const token = createMigrationUuid(1);
  const preparedEventId = createMigrationUuid(1);
  const committedEventId = createMigrationUuid(2);
  const prepared = reduceCoordinatorEvent(
    initialCoordinatorState(),
    migrationEvent(
      1,
      preparedEventId,
      "migration.transitionPrepared",
      {
        transitionId,
        token,
        priorMode: "legacy-active",
        nextMode: "shadow-observe",
        evidence,
        evidenceHash,
        preparedUtc: "2026-07-28T00:00:01.000Z",
      },
    ),
  );
  assert.equal(prepared.migration.mode, "legacy-active");
  assert.equal(prepared.migration.pendingTransition.token, token);

  const committed = reduceCoordinatorEvent(
    prepared,
    migrationEvent(
      2,
      committedEventId,
      "migration.transitionCommitted",
      {
        transitionId,
        token,
        preparedEventId,
        priorMode: "legacy-active",
        nextMode: "shadow-observe",
        evidenceHash,
      },
    ),
  );
  assert.equal(committed.migration.mode, "shadow-observe");
  assert.equal(committed.migration.pendingTransition, null);
  assert.equal(committed.migration.lastTransition.status, "committed");

  const restored = reduceCoordinatorEvent(
    initialCoordinatorState(),
    event(3, "state.checkpoint", {
      state: committed,
      stateHash: hashCoordinatorState(committed),
      priorLastSequence: 2,
    }),
  );
  assert.equal(restored.migration.mode, "shadow-observe");
  assert.equal(
    hashCoordinatorState(restored),
    hashCoordinatorState(committed),
  );
});

test("reducer rejects incoherent migration event and checkpoint state", () => {
  const evidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
  );
  const payload = {
    transitionId: createMigrationUuid(1),
    token: createMigrationUuid(1),
    priorMode: "legacy-active",
    nextMode: "shadow-observe",
    evidence,
    evidenceHash: sha256Json(evidence),
    preparedUtc: "2026-07-28T00:00:01.000Z",
  };
  const preparedEventId = createMigrationUuid(1);
  const prepared = reduceCoordinatorEvent(
    initialCoordinatorState(),
    migrationEvent(
      1,
      preparedEventId,
      "migration.transitionPrepared",
      payload,
    ),
  );

  for (const malformedPayload of [
    { ...payload, evidenceHash: "f".repeat(64) },
    { ...payload, nextMode: "cutover-prepared" },
  ]) {
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          migrationEvent(
            1,
            preparedEventId,
            "migration.transitionPrepared",
            malformedPayload,
          ),
        ),
      /migration|evidence|forbidden|hash/i,
    );
  }
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        prepared,
        migrationEvent(
          2,
          createMigrationUuid(2),
          "migration.transitionPrepared",
          payload,
        ),
      ),
    /pending|overlap/i,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        prepared,
        migrationEvent(
          2,
          createMigrationUuid(2),
          "migration.transitionCommitted",
          {
            transitionId: payload.transitionId,
            token: createMigrationUuid(1),
            preparedEventId,
            priorMode: payload.priorMode,
            nextMode: payload.nextMode,
            evidenceHash: payload.evidenceHash,
          },
        ),
      ),
    /matching|token|migration/i,
  );

  const malformedState = structuredClone(prepared);
  malformedState.migration.mode = "shadow-observe";
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(2, "state.checkpoint", {
          state: malformedState,
          stateHash: hashCoordinatorState(malformedState),
          priorLastSequence: 1,
        }),
      ),
    /migration|prior|mode/i,
  );
});

test("reducer applies the exact migration evidence schema to events and checkpoints", () => {
  const mutations = [
    ["schema version", (value) => {
      value.schemaVersion = 2;
    }],
    ["boot identity", (value) => {
      value.windowsBootId = "windows-boot-2026-07-28-b";
    }],
    ["process identity", (value) => {
      value.processes.supervisor.pid = 0;
    }],
    ["process-role collision", (value) => {
      value.processes.legacy.pid = value.processes.supervisor.pid;
    }],
    ["noncanonical process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator\\sub\\..\\supervisor.exe";
    }],
    ["trailing-dot process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator.\\supervisor.exe";
    }],
    ["reserved-device process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\CON\\supervisor.exe";
    }],
    ["reserved-console-input process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator\\CONIN$.exe";
    }],
    ["reserved-console-output process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator\\CONOUT$";
    }],
    ["reserved-clock process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator\\CLOCK$.exe";
    }],
    ["alternate-stream process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator\\supervisor.exe:stream";
    }],
    ["directory-shaped process path", (value) => {
      value.processes.supervisor.executablePath =
        "C:\\Coordinator\\";
    }],
    ["drive-root process path", (value) => {
      value.processes.supervisor.executablePath = "C:\\";
    }],
    ["event-file boundary", (value) => {
      value.eventFile.cursor = value.eventFile.byteLength + 1;
    }],
    ["event-file remainder", (value) => {
      value.eventFile.remainder += "x";
    }],
    ["journal boundary", (value) => {
      value.journal.sequence = -1;
    }],
    ["routing owner", (value) => {
      value.routingOwnership.nextOwners = ["legacy", "unified"];
    }],
    ["compatibility owner", (value) => {
      value.compatibilityOutputOwnership.nextOwners = ["unified", "legacy"];
    }],
    ["app-server identity", (value) => {
      value.appServer.bootId = "windows-boot-2026-07-28-b";
    }],
    ["app-server role collision", (value) => {
      value.appServer.pid = value.processes.supervisor.pid;
      value.appServer.creationTimeUtc =
        value.processes.supervisor.creationTimeUtc;
    }],
    ["rollback boundary", (value) => {
      value.rollbackBoundary.eventCursor -= 1;
    }],
  ];
  const transitionId = createMigrationUuid(1);
  const token = createMigrationUuid(1);
  const preparedEventId = createMigrationUuid(1);

  for (const [label, mutate] of mutations) {
    const invalidEvidence = migrationEvidence(
      "legacy-active",
      "shadow-observe",
    );
    mutate(invalidEvidence);
    const invalidPayload = {
      transitionId,
      token,
      priorMode: "legacy-active",
      nextMode: "shadow-observe",
      evidence: invalidEvidence,
      evidenceHash: sha256Json(invalidEvidence),
      preparedUtc: "2026-07-28T00:00:01.000Z",
    };
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          migrationEvent(
            1,
            preparedEventId,
            "migration.transitionPrepared",
            invalidPayload,
          ),
        ),
      /migration|boot|process|event-file|journal|owner|rollback|schema/i,
      `${label} event evidence must fail closed`,
    );

    const validEvidence = migrationEvidence(
      "legacy-active",
      "shadow-observe",
    );
    const validState = reduceCoordinatorEvent(
      initialCoordinatorState(),
      migrationEvent(
        1,
        preparedEventId,
        "migration.transitionPrepared",
        {
          ...invalidPayload,
          evidence: validEvidence,
          evidenceHash: sha256Json(validEvidence),
        },
      ),
    );
    validState.migration.pendingTransition.evidence = invalidEvidence;
    validState.migration.pendingTransition.evidenceHash =
      sha256Json(invalidEvidence);
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          event(2, "state.checkpoint", {
            state: validState,
            stateHash: hashCoordinatorState(validState),
            priorLastSequence: 1,
          }),
        ),
      /migration|boot|process|event-file|journal|owner|rollback|schema/i,
      `${label} checkpoint evidence must fail closed`,
    );
  }
});

test("reducer rejects unauthorized and impossible migration chronology", () => {
  const evidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
  );
  const evidenceHash = sha256Json(evidence);
  const preparedPayload = {
    transitionId: createMigrationUuid(1),
    token: createMigrationUuid(1),
    priorMode: "legacy-active",
    nextMode: "shadow-observe",
    evidence,
    evidenceHash,
    preparedUtc: "2026-07-28T00:00:01.000Z",
  };
  const preparedEventId = createMigrationUuid(1);

  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        {
          ...migrationEvent(
            1,
            preparedEventId,
            "migration.transitionPrepared",
            preparedPayload,
          ),
          source: "peer.7",
        },
      ),
    /source|unauthorized/i,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        migrationEvent(
          1,
          preparedEventId,
          "migration.transitionPrepared",
          {
            ...preparedPayload,
            token: preparedPayload.transitionId,
          },
        ),
      ),
    /distinct|UUID/i,
  );

  const prepared = reduceCoordinatorEvent(
    initialCoordinatorState(),
    migrationEvent(
      1,
      preparedEventId,
      "migration.transitionPrepared",
      preparedPayload,
    ),
  );
  const terminalPayload = {
    transitionId: preparedPayload.transitionId,
    token: preparedPayload.token,
    preparedEventId,
    priorMode: preparedPayload.priorMode,
    nextMode: preparedPayload.nextMode,
    evidenceHash,
  };
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        prepared,
        {
          ...migrationEvent(
            2,
            preparedEventId,
            "migration.transitionCommitted",
            terminalPayload,
          ),
          timestampUtc: "2026-07-28T00:00:00.000Z",
        },
      ),
    /terminal|timestamp|event.*identifier|preparation/i,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        prepared,
        migrationEvent(
          2,
          preparedPayload.transitionId,
          "migration.transitionCommitted",
          terminalPayload,
        ),
      ),
    /distinct|UUID/i,
  );
  const intervening = reduceCoordinatorEvent(
    prepared,
    event(2, "runtime.started", { generationId: "runtime-2" }),
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        intervening,
        migrationEvent(
          3,
          createMigrationUuid(2),
          "migration.transitionCommitted",
          terminalPayload,
        ),
      ),
    /terminal|sequence|adjacent/i,
  );

  const committed = reduceCoordinatorEvent(
    prepared,
    migrationEvent(
      2,
      createMigrationUuid(2),
      "migration.transitionCommitted",
      terminalPayload,
    ),
  );
  const nextEvidence = migrationEvidence(
    "shadow-observe",
    "cutover-prepared",
    2,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        committed,
        migrationEvent(
          3,
          createMigrationUuid(3),
          "migration.transitionPrepared",
          {
            ...preparedPayload,
            transitionId: preparedPayload.token,
            token: createMigrationUuid(3),
            priorMode: "shadow-observe",
            nextMode: "cutover-prepared",
            evidence: nextEvidence,
            evidenceHash: sha256Json(nextEvidence),
            preparedUtc: "2026-07-28T00:00:03.000Z",
          },
        ),
      ),
    /reuses|identifier|distinct|UUID|sequence/i,
  );
});

test("reducer rejects fabricated migration lineage and count drift", () => {
  const fabricated = initialCoordinatorState();
  fabricated.migration.mode = "unified-active";
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(1, "state.checkpoint", {
          state: fabricated,
          stateHash: hashCoordinatorState(fabricated),
          priorLastSequence: 0,
        }),
      ),
    /lineage|non-legacy|migration/i,
  );

  const firstEvidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
  );
  const firstHash = sha256Json(firstEvidence);
  const firstPreparedId = createMigrationUuid(1);
  const firstPrepared = reduceCoordinatorEvent(
    initialCoordinatorState(),
    migrationEvent(
      1,
      firstPreparedId,
      "migration.transitionPrepared",
      {
        transitionId: createMigrationUuid(1),
        token: createMigrationUuid(1),
        priorMode: "legacy-active",
        nextMode: "shadow-observe",
        evidence: firstEvidence,
        evidenceHash: firstHash,
        preparedUtc: "2026-07-28T00:00:01.000Z",
      },
    ),
  );
  const committed = reduceCoordinatorEvent(
    firstPrepared,
    migrationEvent(
      2,
      createMigrationUuid(2),
      "migration.transitionCommitted",
      {
        transitionId: firstPrepared.migration.pendingTransition.transitionId,
        token: firstPrepared.migration.pendingTransition.token,
        preparedEventId: firstPreparedId,
        priorMode: "legacy-active",
        nextMode: "shadow-observe",
        evidenceHash: firstHash,
      },
    ),
  );
  const missingCounts = structuredClone(committed);
  delete missingCounts.eventCounts["migration.transitionPrepared"];
  delete missingCounts.eventCounts["migration.transitionCommitted"];
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(3, "state.checkpoint", {
          state: missingCounts,
          stateHash: hashCoordinatorState(missingCounts),
          priorLastSequence: 2,
        }),
      ),
    /count|lineage|migration/i,
  );
  const inflatedCounts = structuredClone(committed);
  inflatedCounts.eventCounts["migration.transitionPrepared"] = 99;
  inflatedCounts.eventCounts["migration.transitionCommitted"] = 99;
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(3, "state.checkpoint", {
          state: inflatedCounts,
          stateHash: hashCoordinatorState(inflatedCounts),
          priorLastSequence: 2,
        }),
      ),
    /count|sequence|history/i,
  );

  const secondEvidence = migrationEvidence(
    "shadow-observe",
    "cutover-prepared",
    2,
  );
  const secondPrepared = reduceCoordinatorEvent(
    committed,
    migrationEvent(
      3,
      createMigrationUuid(3),
      "migration.transitionPrepared",
      {
        transitionId: createMigrationUuid(3),
        token: createMigrationUuid(3),
        priorMode: "shadow-observe",
        nextMode: "cutover-prepared",
        evidence: secondEvidence,
        evidenceHash: sha256Json(secondEvidence),
        preparedUtc: "2026-07-28T00:00:03.000Z",
      },
    ),
  );
  const reversed = structuredClone(secondPrepared);
  reversed.migration.pendingTransition.preparedSequence = 1;
  reversed.migration.pendingTransition.preparedUtc =
    "2026-07-28T00:00:01.000Z";
  reversed.migration.pendingTransition.evidence.journal.sequence = 0;
  reversed.migration.pendingTransition.evidenceHash = sha256Json(
    reversed.migration.pendingTransition.evidence,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        initialCoordinatorState(),
        event(4, "state.checkpoint", {
          state: reversed,
          stateHash: hashCoordinatorState(reversed),
          priorLastSequence: 3,
        }),
      ),
    /precedes|lineage|sequence/i,
  );
});

test("sequence-bound migration UUIDs reject all-history reuse", () => {
  const transition = (
    state,
    preparedSequence,
    priorMode,
    nextMode,
  ) => {
    const evidence = migrationEvidence(
      priorMode,
      nextMode,
      preparedSequence - 1,
    );
    const evidenceHash = sha256Json(evidence);
    const transitionId = createMigrationUuid(preparedSequence);
    const token = createMigrationUuid(preparedSequence);
    const preparedEventId = createMigrationUuid(preparedSequence);
    const prepared = reduceCoordinatorEvent(
      state,
      migrationEvent(
        preparedSequence,
        preparedEventId,
        "migration.transitionPrepared",
        {
          transitionId,
          token,
          priorMode,
          nextMode,
          evidence,
          evidenceHash,
          preparedUtc:
            `2026-07-28T00:00:0${preparedSequence}.000Z`,
        },
      ),
    );
    const committed = reduceCoordinatorEvent(
      prepared,
      migrationEvent(
        preparedSequence + 1,
        createMigrationUuid(preparedSequence + 1),
        "migration.transitionCommitted",
        {
          transitionId,
          token,
          preparedEventId,
          priorMode,
          nextMode,
          evidenceHash,
        },
      ),
    );
    return {
      committed,
      retained: committed.migration.lastTransition,
    };
  };

  const first = transition(
    initialCoordinatorState(),
    1,
    "legacy-active",
    "shadow-observe",
  );
  const second = transition(
    first.committed,
    3,
    "shadow-observe",
    "cutover-prepared",
  );
  const thirdEvidence = migrationEvidence(
    "cutover-prepared",
    "unified-active",
    4,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        second.committed,
        migrationEvent(
          5,
          first.retained.preparedEventId,
          "migration.transitionPrepared",
          {
            transitionId: first.retained.transitionId,
            token: first.retained.token,
            priorMode: "cutover-prepared",
            nextMode: "unified-active",
            evidence: thirdEvidence,
            evidenceHash: sha256Json(thirdEvidence),
            preparedUtc: "2026-07-28T00:00:05.000Z",
          },
        ),
      ),
    /sequence|preparation/i,
  );
});

test("migration UUID namespace cannot be pre-seeded by ordinary events", () => {
  for (const eventId of [
    createMigrationUuid(3),
    createMigrationUuid(3).toUpperCase(),
  ]) {
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          {
            ...event(1, "runtime.started", {
              generationId: "ordinary-runtime-generation",
            }),
            eventId,
          },
        ),
      /migration.*reserved|reserved.*migration/i,
    );
  }
});

test("migration UUIDs are canonical lower-case identifiers", () => {
  const evidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
  );
  const transitionId = createMigrationUuid(1);
  const token = createMigrationUuid(1);
  const preparedEventId = createMigrationUuid(1);
  for (const mutate of [
    (value) => {
      value.eventId = value.eventId.toUpperCase();
    },
    (value) => {
      value.payload.transitionId =
        value.payload.transitionId.toUpperCase();
    },
    (value) => {
      value.payload.token = value.payload.token.toUpperCase();
    },
  ]) {
    const candidate = migrationEvent(
      1,
      preparedEventId,
      "migration.transitionPrepared",
      {
        transitionId,
        token,
        priorMode: "legacy-active",
        nextMode: "shadow-observe",
        evidence,
        evidenceHash: sha256Json(evidence),
        preparedUtc: "2026-07-28T00:00:01.000Z",
      },
    );
    mutate(candidate);
    assert.throws(
      () =>
        reduceCoordinatorEvent(
          initialCoordinatorState(),
          candidate,
        ),
      /migration.*UUID|lower-case|canonical/i,
    );
  }
});

test("migration UUIDs cover the full safe journal sequence range", () => {
  for (const invalid of [
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
  ]) {
    assert.throws(
      () => createMigrationUuid(invalid),
      /positive safe integer|sequence/i,
    );
  }

  for (const sequence of [
    1,
    0xfff,
    0x1000,
    0xffffffff,
    0x100000000,
    2 ** 52,
    Number.MAX_SAFE_INTEGER - 1,
  ]) {
    const evidence = migrationEvidence(
      "legacy-active",
      "shadow-observe",
      sequence - 1,
    );
    const state = initialCoordinatorState();
    state.lastSequence = sequence - 1;
    const projected = reduceCoordinatorEvent(
      state,
      {
        schemaVersion: 1,
        sequence,
        eventId: createMigrationUuid(sequence),
        timestampUtc: "2026-07-28T00:00:01.000Z",
        source: "core.migration",
        type: "migration.transitionPrepared",
        payload: {
          transitionId: createMigrationUuid(sequence),
          token: createMigrationUuid(sequence),
          priorMode: "legacy-active",
          nextMode: "shadow-observe",
          evidence,
          evidenceHash: sha256Json(evidence),
          preparedUtc: "2026-07-28T00:00:01.000Z",
        },
      },
    );
    assert.equal(
      projected.migration.pendingTransition.preparedSequence,
      sequence,
    );
    assert.match(
      projected.migration.pendingTransition.token,
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  }

  assert.match(
    createMigrationUuid(Number.MAX_SAFE_INTEGER),
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/,
  );
});

test("migration prepare reserves capacity for its terminal event", () => {
  const sequence = Number.MAX_SAFE_INTEGER;
  const evidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
    sequence - 2,
  );
  const state = initialCoordinatorState();
  state.lastSequence = sequence - 2;
  const transitionId = createMigrationUuid(sequence - 1);
  const token = createMigrationUuid(sequence - 1);
  const preparedEventId = createMigrationUuid(sequence - 1);
  const prepared = reduceCoordinatorEvent(
    state,
    {
      schemaVersion: 1,
      sequence: sequence - 1,
      eventId: preparedEventId,
      timestampUtc: "2026-07-28T00:00:01.000Z",
      source: "core.migration",
      type: "migration.transitionPrepared",
      payload: {
        transitionId,
        token,
        priorMode: "legacy-active",
        nextMode: "shadow-observe",
        evidence,
        evidenceHash: sha256Json(evidence),
        preparedUtc: "2026-07-28T00:00:01.000Z",
      },
    },
  );
  assert.equal(
    prepared.migration.pendingTransition.preparedSequence,
    sequence - 1,
  );
  const committed = reduceCoordinatorEvent(
    prepared,
    {
      ...migrationEvent(
        sequence,
        createMigrationUuid(sequence),
        "migration.transitionCommitted",
        {
          transitionId,
          token,
          preparedEventId,
          priorMode: "legacy-active",
          nextMode: "shadow-observe",
          evidenceHash: sha256Json(evidence),
        },
      ),
      timestampUtc: "2026-07-28T00:00:02.000Z",
    },
  );
  assert.equal(committed.migration.lastTransition.status, "committed");

  const exhaustedState = initialCoordinatorState();
  exhaustedState.lastSequence = sequence - 1;
  const exhaustedEvidence = migrationEvidence(
    "legacy-active",
    "shadow-observe",
    sequence - 1,
  );
  assert.throws(
    () =>
      reduceCoordinatorEvent(
        exhaustedState,
        {
          ...migrationEvent(
            sequence,
            createMigrationUuid(sequence),
            "migration.transitionPrepared",
            {
              transitionId: createMigrationUuid(sequence),
              token: createMigrationUuid(sequence),
              priorMode: "legacy-active",
              nextMode: "shadow-observe",
              evidence: exhaustedEvidence,
              evidenceHash: sha256Json(exhaustedEvidence),
              preparedUtc: "2026-07-28T00:00:01.000Z",
            },
          ),
          timestampUtc: "2026-07-28T00:00:01.000Z",
        },
      ),
    /terminal.*sequence|capacity|exhaust/i,
  );
});
