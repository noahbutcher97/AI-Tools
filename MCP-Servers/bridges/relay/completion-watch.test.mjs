import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { reportJob, startCompletionBroker } from "./completion-broker.mjs";
import { digest } from "./delivery-protocol.mjs";

const first = { kind: "claude", addressable: true, pid: 5, startedAt: 10, id: "00000000-0000-4000-8000-000000000001" };
const other = { ...first, id: "00000000-0000-4000-8000-000000000002" };
const outcome = { code: 23, signal: null };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-watch-"));
  const state = path.join(root, "completion-state");
  fs.mkdirSync(state);
  const file = path.join(state, "jobs.sqlite");
  await initializeCompletionJobs(file);
  const grants = [first, other].map(target => ({ id: target.id, provider: target.kind,
    instance: digest(JSON.stringify([target.id, target.pid, target.startedAt])) }));
  fs.writeFileSync(path.join(root, "completion-policy.json"), JSON.stringify({ v: 1, grants }));
  const stores = [];
  let listener;
  t.after(async () => {
    if (listener) await listener.close();
    stores.forEach(s => s.close());
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file, async open(options) {
    const store = await openCompletionJobs(file, { permits: () => true, ...options });
    stores.push(store);
    return store;
  }, async start(delivery, port = 0) {
    if (listener) await listener.close();
    listener = await startCompletionBroker(root, { port, delivery });
    return listener;
  } };
}

function ready(store, target, until = 100000) {
  const grant = store.issue(target, until);
  store.complete(grant.id, grant.capability, outcome);
  return grant.id;
}

test("one notice and one original proof cover a burst for the same live instance", async t => {
  const f = await fixture(t);
  let now = 100, sends = [], reads = [], accepted = false;
  const store = await f.open({ now: () => now, send: async (id, body, { onHandle }) => {
    sends.push({ id, body });
    const target = id === first.id ? first : other;
    onHandle("fixture-" + id, target);
    return { state: "pending" };
  }, status: async handle => {
    reads.push(handle);
    return { to: handle.slice(8), state: accepted ? "delivered" : "pending" };
  } });
  const a = ready(store, first);
  now += 400;
  const b = ready(store, first);
  const c = ready(store, other);
  assert.equal(await store.dispatchDue(), false);
  now += 351;
  assert.equal(await store.dispatchDue(), true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].id, first.id);
  assert.ok([a, b].every(id => sends[0].body.includes(id)));
  assert.ok(!sends[0].body.includes(c));
  assert.deepEqual(reads, ["fixture-" + first.id]);
  assert.equal(await store.dispatchDue(), false);
  now += 400;
  await store.dispatchDue();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].id, other.id);
  accepted = true;
  now += 3000;
  await store.dispatchDue();
  assert.equal(sends.length, 2);
  assert.equal(reads.filter(h => h === "fixture-" + first.id).length, 2);
  assert.equal(await store.dispatch(a), "delivered");
  assert.equal(await store.dispatch(b), "delivered");
});

test("revoking a member between capture and reservation suppresses the entire first attempt", async t => {
  const f = await fixture(t);
  let now = 1, revoked, calls = 0, outputs = [];
  const store = await f.open({ now: () => now, status: async () => ({ to: first.id, state: "delivered" }),
    send: async (_, body, options) => {
      options.checkTarget(first);
      if (!calls++) store.revoke(revoked);
      try { options.onHandle("fixture", first); } catch { return { state: "dispatch_failed" }; }
      outputs.push(body);
      return { state: "pending" };
    },
  });
  const live = ready(store, first);
  revoked = ready(store, first);
  now = 1000;
  await store.dispatchDue();
  assert.equal(outputs.length, 0);
  now += 2100;
  await store.dispatchDue();
  assert.equal(outputs.length, 1);
  assert.ok(outputs[0].includes(live) && !outputs[0].includes(revoked));
  assert.equal(await store.dispatch(revoked), "unavailable");
});

test("overflow and fresh arrivals share the recipient cooldown across restart", async t => {
  const f = await fixture(t);
  let now = 1;
  const bodies = [];
  const options = { now: () => now, send: async (_, body, { onHandle }) => {
    bodies.push(body);
    onHandle("handle-" + bodies.length, first);
    return { state: "pending" };
  }, status: async () => ({ state: "delivered", to: first.id }) };
  const store = await f.open(options);
  const ids = Array.from({ length: 9 }, () => ready(store, first));
  now = 1000;
  await store.dispatchDue();
  assert.equal(ids.filter(id => bodies[0].includes(id)).length, 8);
  const more = ready(store, first);
  const restarted = await f.open(options);
  now += 9999;
  assert.equal(await restarted.dispatchDue(), false);
  now++;
  assert.equal(await restarted.dispatchDue(), true);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].includes(more));
  for (const id of ids) assert.equal(bodies.filter(body => body.includes(id)).length, 1);
});

test("watcher recovers the original handle automatically and cannot overlap a stopping listener", async t => {
  const f = await fixture(t);
  const store = await f.open({});
  const job = store.issue(first, Date.now() + 30000);
  let reserved, count = 0;
  const started = new Promise(resolve => { reserved = resolve; });
  const broker = await f.start({ send: async (_, body, options) => {
    assert.ok(body.includes(job.id));
    options.onHandle("original-handle", first);
    count++;
    reserved();
    await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("fixture interrupted after reservation");
  }, status: assert.fail });
  const port = broker.port;
  await assert.rejects(startCompletionBroker(f.root, { port, delivery: { send: assert.fail, status: assert.fail } }));
  await reportJob(job, "claim_run", { session: first.id }, { port });
  await reportJob(job, "complete", outcome, { port });
  await Promise.race([started, delay(5000, null, { ref: false }).then(() => { throw Error("watcher did not start"); })]);
  let verified;
  const proof = new Promise(resolve => { verified = resolve; });
  await f.start({ send: assert.fail, status: async handle => {
    assert.equal(handle, "original-handle");
    verified();
    return { to: first.id, state: "delivered" };
  } }, port);
  await Promise.race([proof, delay(5000, null, { ref: false }).then(() => { throw Error("watcher did not recover"); })]);
  assert.equal(await store.dispatch(job.id), "delivered");
  assert.equal(count, 1);
});

test("an old job database preserves pending work during upgrade", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.file);
  db.exec(`DROP TABLE grant_handoffs; ALTER TABLE jobs DROP COLUMN run_only;
    DROP INDEX jobs_due; DROP INDEX jobs_last_notice; ALTER TABLE jobs DROP COLUMN attempts;
    ALTER TABLE jobs DROP COLUMN next_check; ALTER TABLE jobs DROP COLUMN last_notice; PRAGMA user_version=1`);
  db.prepare("INSERT INTO jobs(id,token_hash,recipient,provider,instance,valid_until,state,handle) VALUES(?,?,?,?,?,?,?,?)")
    .run(other.id, Buffer.alloc(32), first.id, "claude", "instance", 90000, "observing", "original");
  db.close();
  const store = await f.open({ now: () => 100, send: assert.fail, status: async handle => {
    assert.equal(handle, "original");
    return { to: first.id, state: "delivered" };
  } });
  assert.equal(await store.dispatchDue(), true);
  assert.equal(await store.dispatch(other.id), "delivered");
});

test("uncertain dispatch stays out of automatic retries and a permanent denial cannot starve newer jobs", async t => {
  const f = await fixture(t);
  let now = 0, denied = false;
  const calls = [];
  const store = await f.open({ now: () => now, permits: id => !(denied && id === first.id), status: assert.fail,
    send: async id => { calls.push(id); throw Error("fixture stopped before handle"); },
  });
  ready(store, first);
  now++;
  const b = ready(store, other);
  denied = true;
  now = 900;
  await store.dispatchDue();
  await assert.rejects(store.dispatchDue(), /fixture stopped/);
  now = 12000;
  await store.dispatchDue();
  assert.equal(await store.dispatchDue(), false);
  assert.equal(await store.dispatch(b), "unknown");
  assert.deepEqual(calls, [other.id]);
});
