import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateEvent } from "../contracts.mjs";
import { openJournal } from "../core/journal.mjs";
import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "../core/reducer.mjs";
import { createPeerRegistry } from "./registry.mjs";
import {
  createPeerDelivery,
  hashPeerDeliveryState,
  initialPeerState,
  MAX_PEER_STATE_BYTES,
  validatePeerState,
} from "./delivery.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function createIdFactory(prefix = "delivery") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function createClock(initial = "2026-07-29T12:00:00.000Z") {
  let utcMs = Date.parse(initial);
  let monotonicMs = 0;
  return {
    nowUtc: () => new Date(utcMs).toISOString(),
    nowMonotonic: () => monotonicMs,
    advance(ms, { wall = true } = {}) {
      if (wall) {
        utcMs += ms;
      }
      monotonicMs += ms;
    },
    setUtc(value) {
      utcMs = Date.parse(value);
    },
  };
}

class MemoryJournal {
  constructor() {
    this.rootDir = "D:/memory/task-5";
    this.events = [];
  }

  async readFrom(sequence) {
    return structuredClone(
      this.events.filter((event) => event.sequence > sequence),
    );
  }

  async append(event) {
    const validated = validateEvent(event);
    const expected = (this.events.at(-1)?.sequence ?? 0) + 1;
    if (validated.sequence !== expected) {
      throw new RangeError(
        `journal sequence must be ${expected}, received ${validated.sequence}`,
      );
    }
    this.events.push(structuredClone(validated));
    return structuredClone(validated);
  }
}

function peer(peerId) {
  return {
    peerId,
    threadId: `thread-${peerId}`,
    label: peerId === 0 ? "Orchestrator" : `Worker ${peerId}`,
    workspaceRoot: "D:/UnrealProjects/5.6/OperationPhoenix",
    codexVersion: "1.2.3",
    schemaHash: "b".repeat(64),
  };
}

function message(index, overrides = {}) {
  return {
    sourcePeerId: 0,
    targetPeerId: 1,
    mode: "canonical",
    sourceKind: "peer",
    text: `message-${index}`,
    referencePaths: [],
    authorityLabel: "bounded peer request",
    clientDeduplicationKey: `client-${index}`,
    hop: 0,
    ...overrides,
  };
}

function runtimeEvent(journal, type, payload) {
  return {
    schemaVersion: 1,
    sequence: (journal.events.at(-1)?.sequence ?? 0) + 1,
    eventId: `runtime-${journal.events.length + 1}`,
    timestampUtc: "2026-07-29T12:00:00.000Z",
    source: "test",
    type,
    payload,
  };
}

async function createSystem({
  peerCount = 6,
  limits,
  clock = createClock(),
} = {}) {
  const journal = new MemoryJournal();
  const idFactory = createIdFactory();
  const registry = createPeerRegistry({ journal, clock, idFactory });
  for (let peerId = 0; peerId < peerCount; peerId += 1) {
    await registry.registerPeer(peer(peerId));
  }
  const delivery = createPeerDelivery({
    journal,
    clock,
    idFactory,
    ...(limits ? { limits } : {}),
  });
  return { journal, registry, delivery, clock, idFactory };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("FIFO delivery deduplicates clients and preserves target order", async () => {
  const { delivery, journal } = await createSystem();
  const first = await delivery.enqueueMessage(message(1));
  const duplicate = await delivery.enqueueMessage(message(1));
  const second = await delivery.enqueueMessage(message(2));

  assert.equal(first.status, "enqueued");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.message.messageId, first.message.messageId);
  assert.equal(second.status, "enqueued");
  assert.equal(
    journal.events.filter((event) => event.type === "message.enqueued").length,
    2,
  );

  const firstClaim = await delivery.claimNextMessage(1);
  const targetBlocked = await delivery.claimNextMessage(1);
  assert.equal(firstClaim.message.messageId, first.message.messageId);
  assert.deepEqual(targetBlocked, {
    status: "blocked",
    reason: "target-active",
  });

  await delivery.completeMessage(first.message.messageId, "first-result");
  const secondClaim = await delivery.claimNextMessage(1);
  assert.equal(secondClaim.message.messageId, second.message.messageId);
});

test("FIFO queue applies the exact twenty-five message cap without eviction", async () => {
  const { delivery } = await createSystem();
  const accepted = [];
  for (let index = 0; index < 25; index += 1) {
    accepted.push(await delivery.enqueueMessage(message(index)));
  }
  const rejected = await delivery.enqueueMessage(message(25));
  const state = await delivery.readState();

  assert.equal(accepted.every((result) => result.status === "enqueued"), true);
  assert.deepEqual(rejected, {
    status: "backpressure",
    reason: "target-queue-full",
    targetPeerId: 1,
  });
  assert.equal(state.delivery.queues["1"].length, 25);
  assert.equal(state.delivery.queues["1"][0], accepted[0].message.messageId);
});

test("mailbox completion and acknowledgement are bounded and owner-only", async () => {
  const { delivery } = await createSystem({
    limits: {
      mailboxRecordsPerPeer: 2,
    },
  });

  for (let index = 0; index < 2; index += 1) {
    const enqueued = await delivery.enqueueMessage(message(index));
    await delivery.claimNextMessage(1);
    await delivery.completeMessage(enqueued.message.messageId, `result-${index}`);
  }

  const state = await delivery.readState();
  assert.equal(state.delivery.mailboxes["0"].length, 2);
  await assert.rejects(
    delivery.ackMessage(state.delivery.mailboxes["0"][0].messageId, 1),
    /mailbox owner/i,
  );
  const acknowledged = await delivery.ackMessage(
    state.delivery.mailboxes["0"][0].messageId,
    0,
  );
  assert.equal(acknowledged.status, "acknowledged");
  const repeatedAck = await delivery.ackMessage(
    state.delivery.mailboxes["0"][0].messageId,
    0,
  );
  assert.equal(repeatedAck.status, "already-acknowledged");
  await assert.rejects(
    delivery.completeMessage("missing-message", "result"),
    /not dispatching/i,
  );
  await assert.rejects(
    delivery.completeMessage(
      state.delivery.mailboxes["0"][1].messageId,
      "x".repeat(4_001),
    ),
    /result text/i,
  );
});

test("mailbox capacity is reserved before accepting more reply work", async () => {
  const { delivery } = await createSystem({
    limits: {
      mailboxRecordsPerPeer: 2,
    },
  });

  for (let index = 0; index < 2; index += 1) {
    const enqueued = await delivery.enqueueMessage(message(index));
    await delivery.claimNextMessage(1);
    await delivery.completeMessage(enqueued.message.messageId, "done");
  }
  const rejected = await delivery.enqueueMessage(message(3));

  assert.deepEqual(rejected, {
    status: "backpressure",
    reason: "source-mailbox-full",
    sourcePeerId: 0,
  });
});

test("mailbox capacity reserves queued replies and acknowledged records free it", async () => {
  const { delivery } = await createSystem({
    limits: {
      mailboxRecordsPerPeer: 2,
    },
  });
  const first = await delivery.enqueueMessage(message("reserve-1"));
  const second = await delivery.enqueueMessage(message("reserve-2"));
  const reserved = await delivery.enqueueMessage(message("reserve-3"));
  assert.equal(first.status, "enqueued");
  assert.equal(second.status, "enqueued");
  assert.deepEqual(reserved, {
    status: "backpressure",
    reason: "source-mailbox-full",
    sourcePeerId: 0,
  });

  await delivery.claimNextMessage(1);
  await delivery.completeMessage(first.message.messageId, "done");
  await delivery.claimNextMessage(1);
  await delivery.completeMessage(second.message.messageId, "done");
  await delivery.ackMessage(first.message.messageId, 0);
  const afterAck = await delivery.enqueueMessage(message("reserve-4"));
  assert.equal(afterAck.status, "enqueued");
});

test("acknowledgement history is retained for seven days and then pruned", async () => {
  const clock = createClock();
  const { delivery } = await createSystem({ clock });
  const enqueued = await delivery.enqueueMessage(message("retention"));
  await delivery.claimNextMessage(1);
  await delivery.completeMessage(enqueued.message.messageId, "done");
  await delivery.ackMessage(enqueued.message.messageId, 0);

  const retained = await delivery.readState();
  assert.equal(
    retained.delivery.acknowledgements[enqueued.message.messageId]
      .sourcePeerId,
    0,
  );
  assert.equal(retained.delivery.mailboxes["0"].length, 0);

  clock.advance(7 * 24 * HOUR + 1);
  await delivery.enqueueMessage(message("after-retention"));
  const pruned = await delivery.readState();
  assert.equal(
    Object.hasOwn(
      pruned.delivery.acknowledgements,
      enqueued.message.messageId,
    ),
    false,
  );
  assert.equal(
    pruned.delivery.mailboxes["0"].some(
      (record) => record.messageId === enqueued.message.messageId,
    ),
    false,
  );
});

test("acknowledged history never consumes the exact mailbox record cap", async () => {
  const { delivery } = await createSystem({
    limits: {
      canonicalPerHour: 1_000,
      canonicalPerDay: 1_000,
    },
  });
  assert.equal(delivery.limits.mailboxRecordsPerPeer, 100);

  for (let index = 0; index < 3; index += 1) {
    const enqueued = await delivery.enqueueMessage(message(`bounded-${index}`));
    await delivery.claimNextMessage(1);
    await delivery.completeMessage(enqueued.message.messageId, "done");
    await delivery.ackMessage(enqueued.message.messageId, 0);
    const state = await delivery.readState();
    assert.ok(state.delivery.mailboxes["0"].length <= 100);
  }

  const state = await delivery.readState();
  assert.equal(state.delivery.mailboxes["0"].length, 0);
  assert.equal(
    Object.keys(state.delivery.acknowledgements).length,
    3,
  );
});

test("acknowledgement bypasses saturated ordinary model queues", async () => {
  const { delivery } = await createSystem({
    limits: {
      queuedMessagesPerPeer: 2,
    },
  });
  const completed = await delivery.enqueueMessage(message("control-ack"));
  await delivery.claimNextMessage(1);
  await delivery.completeMessage(completed.message.messageId, "done");
  await delivery.enqueueMessage(message("queue-full-1"));
  await delivery.enqueueMessage(message("queue-full-2"));

  const acknowledged = await delivery.ackMessage(
    completed.message.messageId,
    0,
  );
  assert.equal(acknowledged.status, "acknowledged");
});

test("stop and recovery events bypass saturated ordinary model queues", async () => {
  const { delivery, journal } = await createSystem();
  for (let index = 0; index < 25; index += 1) {
    await delivery.enqueueMessage(message(`saturated-${index}`));
  }

  await journal.append(runtimeEvent(journal, "runtime.stopped", {}));
  await journal.append(
    runtimeEvent(journal, "runtime.degraded", { reason: "test-fault" }),
  );
  await journal.append(
    runtimeEvent(journal, "runtime.recovered", {
      probeId: "probe-saturated-control",
      evidenceSha256: "a".repeat(64),
    }),
  );
  const coordinator = (await journal.readFrom(0)).reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );

  assert.equal(coordinator.peers.delivery.queues["1"].length, 25);
  assert.equal(coordinator.runtime.health, "healthy");
  assert.equal(
    coordinator.runtime.lastRecoveryProbeId,
    "probe-saturated-control",
  );
});

test("delivery enforces one active target and three global active turns", async () => {
  const { delivery } = await createSystem();
  for (let targetPeerId = 1; targetPeerId <= 4; targetPeerId += 1) {
    await delivery.enqueueMessage(
      message(targetPeerId, {
        targetPeerId,
        clientDeduplicationKey: `global-${targetPeerId}`,
      }),
    );
  }

  const active = [];
  for (let count = 0; count < 3; count += 1) {
    active.push(await delivery.claimNextMessage());
  }
  const blocked = await delivery.claimNextMessage();

  assert.equal(new Set(active.map((item) => item.message.targetPeerId)).size, 3);
  assert.deepEqual(blocked, {
    status: "blocked",
    reason: "global-active-limit",
  });

  await delivery.completeMessage(active[0].message.messageId, "done");
  const resumed = await delivery.claimNextMessage();
  assert.equal(resumed.status, "dispatching");
});

test("delivery scheduling provides four-two-one weighting without starvation", async () => {
  const { delivery } = await createSystem();
  const inputs = [
    ...Array.from({ length: 4 }, (_, index) =>
      message(`c-${index}`, {
        targetPeerId: 1,
        clientDeduplicationKey: `c-${index}`,
      })),
    ...Array.from({ length: 2 }, (_, index) =>
      message(`m-${index}`, {
        targetPeerId: 2,
        mode: "material-sensor",
        sourceKind: "sensor",
        clientDeduplicationKey: `m-${index}`,
      })),
    message("s-0", {
      targetPeerId: 3,
      mode: "sidecar",
      clientDeduplicationKey: "s-0",
    }),
  ];
  for (const input of inputs) {
    await delivery.enqueueMessage(input);
  }

  const selected = [];
  for (let index = 0; index < 7; index += 1) {
    const claim = await delivery.claimNextMessage();
    selected.push(claim.message.mode);
    await delivery.completeMessage(claim.message.messageId, "done");
  }

  assert.deepEqual(selected, [
    "canonical",
    "canonical",
    "material-sensor",
    "canonical",
    "sidecar",
    "canonical",
    "material-sensor",
  ]);
  for (let index = 2; index < selected.length; index += 1) {
    assert.equal(
      selected[index] === selected[index - 1] &&
        selected[index] === selected[index - 2],
      false,
    );
  }
});

test("conversation enforces one directed turn, four hops, and no coalescing", async () => {
  const { delivery } = await createSystem();
  const initial = await delivery.enqueueMessage(message("initial"));
  const conversationId = initial.message.conversationId;

  await assert.rejects(
    delivery.enqueueMessage(
      message("overlap", {
        conversationId,
        hop: 1,
      }),
    ),
    /conversation already has queued or active work/i,
  );

  let current = initial;
  for (let hop = 0; hop <= 4; hop += 1) {
    const claim = await delivery.claimNextMessage(current.message.targetPeerId);
    await delivery.completeMessage(claim.message.messageId, `hop-${hop}`);
    if (hop < 4) {
      current = await delivery.enqueueMessage(
        message(`hop-${hop + 1}`, {
          sourcePeerId: current.message.targetPeerId,
          targetPeerId: current.message.sourcePeerId,
          conversationId,
          hop: hop + 1,
        }),
      );
    }
  }

  const capped = await delivery.enqueueMessage(
    message("hop-5", {
      conversationId,
      hop: 5,
    }),
  );
  const state = await delivery.readState();
  assert.deepEqual(capped, {
    status: "conversation-closed",
    reason: "hop-limit",
    conversationId,
  });
  assert.equal(state.delivery.conversations[conversationId].status, "closed");
  assert.equal(state.delivery.conversations[conversationId].closeReason, "hop-limit");
});

test("conversation clock expires without extension after wall rollback", async () => {
  const clock = createClock();
  const { delivery } = await createSystem({ clock });
  const initial = await delivery.enqueueMessage(message("clock"));
  const conversationId = initial.message.conversationId;
  const claim = await delivery.claimNextMessage(1);
  await delivery.completeMessage(claim.message.messageId, "done");

  clock.advance(29 * MINUTE);
  clock.setUtc("2026-07-29T10:00:00.000Z");
  clock.advance(2 * MINUTE, { wall: false });
  const expired = await delivery.enqueueMessage(
    message("late-reply", {
      sourcePeerId: 1,
      targetPeerId: 0,
      conversationId,
      hop: 1,
    }),
  );

  assert.deepEqual(expired, {
    status: "conversation-closed",
    reason: "expired",
    conversationId,
  });
});

test("conversation restart reconstructs remaining TTL from its UTC deadline", async () => {
  const clock = createClock();
  const { journal, delivery, idFactory } = await createSystem({ clock });
  const initial = await delivery.enqueueMessage(message("restart"));
  const claim = await delivery.claimNextMessage(1);
  await delivery.completeMessage(claim.message.messageId, "done");

  clock.advance(31 * MINUTE);
  const reopened = createPeerDelivery({ journal, clock, idFactory });
  const expired = await reopened.enqueueMessage(
    message("restart-late", {
      sourcePeerId: 1,
      targetPeerId: 0,
      conversationId: initial.message.conversationId,
      hop: 1,
    }),
  );

  assert.equal(expired.status, "conversation-closed");
  assert.equal(expired.reason, "expired");
});

test("budget clock defers without removing queued work and separates sources", async () => {
  const clock = createClock();
  const { delivery } = await createSystem({
    clock,
    limits: {
      canonicalPerHour: 2,
      canonicalPerDay: 3,
      sidecarPerHour: 1,
      sidecarPerDay: 2,
    },
  });

  for (let index = 0; index < 2; index += 1) {
    const enqueued = await delivery.enqueueMessage(message(`budget-${index}`));
    await delivery.claimNextMessage(1);
    await delivery.completeMessage(enqueued.message.messageId, "done");
  }

  const waiting = await delivery.enqueueMessage(message("budget-waiting"));
  const deferred = await delivery.claimNextMessage(1);
  const afterDeferral = await delivery.readState();
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.reason, "hour-budget");
  assert.equal(
    afterDeferral.delivery.queues["1"].includes(waiting.message.messageId),
    true,
  );
  assert.equal(
    afterDeferral.delivery.messages[waiting.message.messageId].status,
    "queued",
  );

  clock.advance(HOUR + 1);
  const resumed = await delivery.claimNextMessage(1);
  await delivery.completeMessage(resumed.message.messageId, "done");
  const dayLimit = await delivery.usage.canStart({
    mode: "canonical",
    source: "peer",
  });
  assert.equal(dayLimit.allowed, false);
  assert.equal(dayLimit.reason, "day-budget");

  const state = await delivery.readState();
  assert.equal(state.delivery.usage.canonical.peer.length, 3);
  assert.equal(state.delivery.usage.canonical.sensor.length, 0);
});

test("sidecar budget is independent from canonical usage", async () => {
  const { delivery } = await createSystem({
    limits: {
      canonicalPerHour: 1,
      canonicalPerDay: 1,
      sidecarPerHour: 1,
      sidecarPerDay: 1,
    },
  });
  const canonical = await delivery.enqueueMessage(message("canonical"));
  await delivery.claimNextMessage(1);
  await delivery.completeMessage(canonical.message.messageId, "done");

  const canonicalGate = await delivery.usage.canStart({
    mode: "canonical",
    source: "peer",
  });
  const sidecarGate = await delivery.usage.canStart({
    mode: "sidecar",
    source: "peer",
  });
  assert.equal(canonicalGate.allowed, false);
  assert.equal(sidecarGate.allowed, true);
});

test("budget limit overrides can be configured only by peer zero", async () => {
  const journal = new MemoryJournal();
  const clock = createClock();
  const idFactory = createIdFactory();
  assert.throws(
    () =>
      createPeerDelivery({
        journal,
        clock,
        idFactory,
        limitsOwnerPeerId: 1,
        limits: {
          canonicalPerHour: 5,
          canonicalPerDay: 25,
        },
      }),
    /only peer 0/i,
  );
  const delivery = createPeerDelivery({
    journal,
    clock,
    idFactory,
    limitsOwnerPeerId: 0,
    limits: {
      canonicalPerHour: 5,
      canonicalPerDay: 25,
    },
  });
  assert.equal(delivery.limits.canonicalPerHour, 5);
  assert.equal(delivery.limits.canonicalPerDay, 25);
  assert.throws(
    () =>
      createPeerDelivery({
        journal,
        clock,
        idFactory,
        limitsOwnerPeerId: 0,
        limits: {
          messageTextCharacters: 2_001,
        },
      }),
    /schema ceiling/i,
  );
});

test("delivery rejects malformed messages before durable mutation", async () => {
  const { delivery, journal } = await createSystem();
  const before = journal.events.length;
  const invalidMessages = [
    message("missing-target", { targetPeerId: 99 }),
    message("oversized", { text: "x".repeat(2_001) }),
    message("references", {
      referencePaths: Array.from({ length: 6 }, (_, index) => `D:/r/${index}`),
    }),
    message("reserved", { conversationId: "constructor" }),
    message("hop", { hop: -1 }),
    message("mode", { mode: "unknown" }),
  ];

  for (const invalid of invalidMessages) {
    await assert.rejects(delivery.enqueueMessage(invalid));
  }
  assert.equal(journal.events.length, before);
});

test("peer checkpoint capacity returns typed backpressure with result space reserved", async () => {
  const { delivery } = await createSystem();
  const largeReference = `D:/${"r".repeat(1_020)}`;
  let capacityResult = null;
  for (let index = 0; index < 100; index += 1) {
    const result = await delivery.enqueueMessage(
      message(`capacity-${index}`, {
        targetPeerId: (index % 5) + 1,
        text: "x".repeat(2_000),
        referencePaths: Array.from({ length: 5 }, () => largeReference),
      }),
    );
    if (result.status === "backpressure") {
      capacityResult = result;
      break;
    }
  }

  assert.deepEqual(capacityResult, {
    status: "backpressure",
    reason: "peer-state-capacity",
  });
  const state = await delivery.readState();
  assert.ok(
    Buffer.byteLength(JSON.stringify(state), "utf8") < MAX_PEER_STATE_BYTES,
  );
});

test("delivery and acknowledgement mutations fail closed while degraded", async () => {
  const { delivery, journal } = await createSystem();
  const enqueued = await delivery.enqueueMessage(message("degraded"));
  await delivery.claimNextMessage(1);
  await delivery.completeMessage(enqueued.message.messageId, "done");
  await journal.append(
    runtimeEvent(journal, "runtime.degraded", { reason: "flush-failed" }),
  );

  await assert.rejects(
    delivery.enqueueMessage(message("rejected")),
    /degraded-read-only/i,
  );
  await assert.rejects(
    delivery.ackMessage(enqueued.message.messageId, 0),
    /degraded-read-only/i,
  );
  assert.equal(journal.events.at(-1).type, "runtime.degraded");
});

test("unregister refuses stale-work inheritance until all work is acknowledged", async () => {
  const { registry, delivery } = await createSystem();
  const enqueued = await delivery.enqueueMessage(message("identity-fence"));

  await assert.rejects(registry.unregisterPeer(1), /outstanding peer work/i);
  await delivery.claimNextMessage(1);
  await assert.rejects(registry.unregisterPeer(1), /outstanding peer work/i);
  await delivery.completeMessage(enqueued.message.messageId, "done");
  await assert.rejects(registry.unregisterPeer(1), /outstanding peer work/i);
  await delivery.ackMessage(enqueued.message.messageId, 0);

  const removed = await registry.unregisterPeer(1);
  assert.equal(removed.status, "unregistered");
});

test("delivery-unknown releases active capacity without automatic retry", async () => {
  const { delivery, journal, clock } = await createSystem();
  const enqueued = await delivery.enqueueMessage(message("ambiguous"));
  await delivery.claimNextMessage(1);
  await journal.append({
    schemaVersion: 1,
    sequence: journal.events.at(-1).sequence + 1,
    eventId: "delivery-unknown-1",
    timestampUtc: clock.nowUtc(),
    source: "app-server",
    type: "message.deliveryUnknown",
    payload: {
      messageId: enqueued.message.messageId,
      mailboxPeerId: 0,
      reason: "connection-lost-after-dispatch",
      unknownUtc: clock.nowUtc(),
    },
  });

  const state = await delivery.readState();
  assert.equal(
    state.delivery.messages[enqueued.message.messageId].status,
    "delivery-unknown",
  );
  assert.equal(state.delivery.activeCount, 0);
  assert.equal(Object.hasOwn(state.delivery.activeByTarget, "1"), false);
  assert.equal(state.delivery.queues["1"].length, 0);
  assert.equal(
    state.delivery.mailboxes["0"][0].messageId,
    enqueued.message.messageId,
  );
});

test("restart clock regression cannot mint a fresh conversation TTL", async () => {
  const clock = createClock();
  const { delivery, journal, idFactory } = await createSystem({ clock });
  const initial = await delivery.enqueueMessage(message("clock-anchor"));
  await delivery.claimNextMessage(1);
  clock.advance(10 * MINUTE);
  await delivery.completeMessage(initial.message.messageId, "done");

  const regressedClock = createClock("2026-07-29T11:00:00.000Z");
  const reopened = createPeerDelivery({
    journal,
    clock: regressedClock,
    idFactory,
  });
  const result = await reopened.enqueueMessage(
    message("clock-regressed-reply", {
      sourcePeerId: 1,
      targetPeerId: 0,
      conversationId: initial.message.conversationId,
      hop: 1,
    }),
  );

  assert.deepEqual(result, {
    status: "conversation-closed",
    reason: "expired",
    conversationId: initial.message.conversationId,
  });
});

test("delivery replay produces the same bounded state hash", async () => {
  const { journal, delivery, clock, idFactory } = await createSystem();
  const enqueued = await delivery.enqueueMessage(message("replay"));
  await delivery.claimNextMessage(1);
  await delivery.completeMessage(enqueued.message.messageId, "result");

  const before = await delivery.readState();
  const reopened = createPeerDelivery({ journal, clock, idFactory });
  const after = await reopened.readState();

  assert.deepEqual(after, before);
  assert.equal(
    hashPeerDeliveryState(after.delivery),
    hashPeerDeliveryState(before.delivery),
  );
});

test("delivery survives a checkpoint and remains mutable after reopen", async (t) => {
  const rootDir = await temporaryRoot(t);
  const journal = await openJournal({ rootDir });
  const clock = createClock();
  const idFactory = createIdFactory();
  const registry = createPeerRegistry({ journal, clock, idFactory });
  await registry.registerPeer(peer(0));
  await registry.registerPeer(peer(1));
  const delivery = createPeerDelivery({ journal, clock, idFactory });
  const enqueued = await delivery.enqueueMessage(message("checkpoint"));

  const coordinatorState = (await journal.readFrom(0)).reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
  await journal.checkpoint(coordinatorState);
  await journal.rotate();

  const reopened = createPeerDelivery({ journal, clock, idFactory });
  const claim = await reopened.claimNextMessage(1);
  assert.equal(claim.message.messageId, enqueued.message.messageId);
  await reopened.completeMessage(claim.message.messageId, "after-checkpoint");
  const state = await reopened.readState();
  assert.equal(
    state.delivery.messages[claim.message.messageId].result,
    "after-checkpoint",
  );
});

test("peer checkpoint validation rejects malformed nested delivery state", () => {
  const malformedConversation = initialPeerState();
  malformedConversation.delivery.conversations.bad = {
    status: "open",
  };
  assert.throws(
    () => validatePeerState(malformedConversation),
    /conversation/i,
  );

  const malformedMessage = initialPeerState();
  malformedMessage.delivery.messages.bad = {
    messageId: "bad",
    mode: "canonical",
    sourcePeerId: 0,
    targetPeerId: 1,
    sourceKind: "peer",
    status: "completed",
  };
  assert.throws(
    () => validatePeerState(malformedMessage),
    /message/i,
  );
});
