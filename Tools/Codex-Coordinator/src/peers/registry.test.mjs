import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateEvent } from "../contracts.mjs";
import { openJournal } from "../core/journal.mjs";
import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "../core/reducer.mjs";
import {
  createPeerRegistry,
  hashPeerRegistryState,
} from "./registry.mjs";

function createIdFactory(prefix = "registry") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function createClock(initial = "2026-07-29T12:00:00.000Z") {
  let utcMs = Date.parse(initial);
  let monotonicMs = 0;
  return {
    nowUtc: () => new Date(utcMs).toISOString(),
    nowMonotonic: () => monotonicMs,
    advance(ms) {
      utcMs += ms;
      monotonicMs += ms;
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

function peer(peerId, threadId = `thread-${peerId}`) {
  return {
    peerId,
    threadId,
    label: peerId === 0 ? "Orchestrator" : `Lane ${peerId}`,
    workspaceRoot: "D:/UnrealProjects/5.6/OperationPhoenix",
    codexVersion: "1.2.3",
    schemaHash: "a".repeat(64),
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

async function temporaryRoot(t) {
  const container = await mkdtemp(
    path.join(tmpdir(), "coordinator-peers-"),
  );
  const root = path.join(container, "runtime");
  await mkdir(root, { recursive: true });
  t.after(() => rm(container, { recursive: true, force: true }));
  return root;
}

test("registry accepts peer zero and workers through one hundred", async () => {
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });

  const orchestrator = await registry.registerPeer(peer(0));
  const worker = await registry.registerPeer(peer(100));
  const state = await registry.readState();

  assert.equal(orchestrator.status, "registered");
  assert.equal(worker.status, "registered");
  assert.equal(state.peers["0"].attachment, "registered-unattached");
  assert.equal(state.peers["100"].attachment, "registered-unattached");
  assert.equal(state.threadToPeer["thread-0"], 0);
  assert.equal(state.threadToPeer["thread-100"], 100);
  assert.equal(journal.events.length, 2);
});

test("registry rejects invalid peer identities and metadata before mutation", async () => {
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });

  for (const invalidPeerId of [-1, 101, "1", 1.5]) {
    await assert.rejects(
      registry.registerPeer(peer(invalidPeerId)),
      /peer ID/i,
    );
  }
  await assert.rejects(
    registry.registerPeer({ ...peer(1), threadId: "" }),
    /thread ID/i,
  );
  await assert.rejects(
    registry.registerPeer({ ...peer(1), workspaceRoot: "relative/path" }),
    /workspace root/i,
  );
  await assert.rejects(
    registry.registerPeer({ ...peer(1), codexVersion: "latest" }),
    /Codex version/i,
  );
  await assert.rejects(
    registry.registerPeer({ ...peer(1), schemaHash: "not-a-hash" }),
    /schema hash/i,
  );
  await assert.rejects(
    registry.registerPeer({ ...peer(1), threadId: "__proto__" }),
    /thread ID/i,
  );
  await assert.rejects(
    registry.registerPeer({ ...peer(1), threadId: "constructor" }),
    /thread ID/i,
  );
  assert.equal(journal.events.length, 0);
});

test("registry mutations fail closed while runtime is degraded read-only", async () => {
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });
  await registry.registerPeer(peer(1));
  await journal.append(
    runtimeEvent(journal, "runtime.degraded", { reason: "disk-full" }),
  );

  await assert.rejects(
    registry.registerPeer(peer(2)),
    /degraded-read-only/i,
  );
  await assert.rejects(registry.unregisterPeer(1), /degraded-read-only/i);
  assert.equal(journal.events.at(-1).type, "runtime.degraded");
});

test("registry is idempotent only for the same peer and thread", async () => {
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });

  await registry.registerPeer(peer(1));
  const repeated = await registry.registerPeer({
    ...peer(1),
    label: "Metadata does not replace the durable registration",
  });

  assert.equal(repeated.status, "already-registered");
  assert.equal(journal.events.length, 1);
  await assert.rejects(
    registry.registerPeer(peer(1, "different-thread")),
    /explicit unregister/i,
  );
  await assert.rejects(
    registry.registerPeer(peer(2, "thread-1")),
    /already registered to peer 1/i,
  );
  assert.equal(journal.events.length, 1);
});

test("registry requires explicit unregister before replacement", async () => {
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });

  await registry.registerPeer(peer(1));
  const removed = await registry.unregisterPeer(1);
  const replacement = await registry.registerPeer(peer(1, "thread-new"));
  const state = await registry.readState();

  assert.equal(removed.status, "unregistered");
  assert.equal(replacement.status, "registered");
  assert.equal(state.peers["1"].threadId, "thread-new");
  assert.equal(state.threadToPeer["thread-new"], 1);
  assert.equal(Object.hasOwn(state.threadToPeer, "thread-1"), false);
  await assert.rejects(registry.unregisterPeer(2), /not registered/i);
});

test("registry serializes concurrent idempotent registration", async () => {
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => registry.registerPeer(peer(1))),
  );

  assert.equal(
    results.filter((result) => result.status === "registered").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "already-registered").length,
    7,
  );
  assert.equal(journal.events.length, 1);
});

test("registry reconstructs the same state and hash from durable events", async () => {
  const journal = new MemoryJournal();
  const clock = createClock();
  const registry = createPeerRegistry({
    journal,
    clock,
    idFactory: createIdFactory("first"),
  });
  await registry.registerPeer(peer(0));
  clock.advance(1_000);
  await registry.registerPeer(peer(1));
  await registry.unregisterPeer(1);

  const before = await registry.readState();
  const reopened = createPeerRegistry({
    journal,
    clock,
    idFactory: createIdFactory("second"),
  });
  const after = await reopened.readState();

  assert.deepEqual(after, before);
  assert.equal(hashPeerRegistryState(after), hashPeerRegistryState(before));
});

test("registry survives an authoritative journal checkpoint", async (t) => {
  const rootDir = await temporaryRoot(t);
  const journal = await openJournal({ rootDir });
  const registry = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory(),
  });
  await registry.registerPeer(peer(0));
  await registry.registerPeer(peer(1));

  const events = await journal.readFrom(0);
  const coordinatorState = events.reduce(
    (state, event) => reduceCoordinatorEvent(state, event),
    initialCoordinatorState(),
  );
  assert.equal(coordinatorState.peers.registry.peers["1"].threadId, "thread-1");

  await journal.checkpoint(coordinatorState);
  const reopened = createPeerRegistry({
    journal,
    clock: createClock(),
    idFactory: createIdFactory("reopened"),
  });
  const state = await reopened.readState();

  assert.equal(state.peers["0"].threadId, "thread-0");
  assert.equal(state.peers["1"].threadId, "thread-1");
});
