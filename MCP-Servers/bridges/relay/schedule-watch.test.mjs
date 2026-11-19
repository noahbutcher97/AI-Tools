import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { parseArgs } from "./client.mjs";
import { listenForJobReports, reportJob, startCompletionBroker } from "./completion-broker.mjs";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { scheduleNotice } from "./completion-protocol.mjs";
import { readScheduleGrant } from "./run-handoff.mjs";
import { scheduleBinding, validSchedule } from "./schedule-watch.mjs";
import { subscribeWatch } from "./watch-client.mjs";
import { readWatcher } from "./watcher-health.mjs";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-schedule-"));
  const file = path.join(root, "completion-state", "jobs.sqlite");
  for (const dir of ["completion-state","completion-grants","completion-health"]) fs.mkdirSync(path.join(root, dir));
  await initializeCompletionJobs(file);
  const target = randomUUID(), start = Date.now();
  const g = { condition: randomUUID(), target, provider: "codex", scope: "thread-schedule",
    startsAt: new Date(start).toISOString(), expiresAt: new Date(start + 86400000).toISOString(), intervalSeconds: 60 };
  const session = { id: target, kind: "codex", addressable: true, pid: null, startedAt: null };
  const handle = "local-proof." + "a".repeat(48);
  const f = { root, file, start, now: start, g, session, handle, policy: [g], sends: 0, proofs: 0,
    proof: { state: "pending", to: target }, to: target };
  let listener;
  f.send = async (to, body, options) => {
    assert.equal(to, target);
    assert.equal(body, scheduleNotice);
    assert.equal(options.allowDelegate, false);
    await options.checkTarget(session);
    await options.onHandle(handle, session);
    f.sends++;
    return { state: "pending" };
  };
  f.restart = async () => {
    await listener?.close();
    f.store?.close();
    f.store = await openCompletionJobs(file, { now: () => f.now, schedules: { root, policy: () => f.policy },
      send: (...args) => f.send(...args), status: async h => { assert.equal(h, handle); f.proofs++; return f.proof; } });
    f.store.watches.provision();
    listener = await listenForJobReports(f.store.acceptFrame, { port: 0 });
  };
  t.after(async () => { await listener?.close(); f.store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  f.subscribe = (id = g.condition) => subscribeWatch(target, id, { id: target, provider: "codex" }, { root, port: listener.port });
  f.observe = () => f.store.watches.dispatchDue();
  f.rows = () => f.store.watches.subscriptions(f.policy);
  f.report = (grant, op, event) => reportJob(grant, op, event, { port: listener.port });
  await f.restart();
  return f;
}

test("schedule activation sets a baseline and missed ticks share one proved wake across restart", async t => {
  const f = await fixture(t);
  const other = { ...f.g, condition: randomUUID() };
  f.policy.push(other);
  f.store.watches.provision();
  f.now += 100 * 60000;
  for (const g of f.policy) assert.equal((await f.subscribe(g.condition)).state, "subscribed");
  assert.equal(await f.observe(), false);
  f.now += 4 * 60000;
  await f.restart();
  assert.equal((await f.subscribe()).ok, true);
  assert.equal(await f.observe(), true);
  assert.equal(f.sends, 1);
  assert.deepEqual(f.rows().map(s => s.state), ["observing","observing"]);
  await f.restart();
  f.now += 5 * 60000;
  assert.equal(await f.observe(), true);
  assert.equal(f.proofs, 1);
  f.proof = { state: "delivered", to: randomUUID() };
  f.now += 10000;
  await f.observe();
  assert.equal(f.rows()[0].state, "observing");
  f.proof.to = f.to;
  f.now += 10000;
  await f.observe();
  assert.deepEqual(f.rows().map(s => s.state), ["waiting","waiting"]);
  assert.equal(f.sends, 1);
  f.now -= 5 * 60000;
  assert.equal(await f.observe(), false);
});

test("fixed clock grants reject redirection, job operations and reused conditions with amended policy", async t => {
  const f = await fixture(t);
  const g = f.g;
  assert.deepEqual(parseArgs(["watch","--notify",f.to,g.condition]), { command: "watch", to: f.to, condition: g.condition });
  for (const args of [["--notify",f.to,"../fixture"], ["--notify",f.to,g.condition,"extra"], ["--notify","host:"+f.to,g.condition]]) {
    assert.throws(() => parseArgs(["watch", ...args]));
  }
  for (const patch of [{ intervalSeconds: 59 }, { intervalSeconds: 60.5 }, { scope: "thread-status" }, { provider: "claude" },
    { startsAt: "2030-01-01" }, { target: "a/b" }, { body: "test" }]) assert.equal(validSchedule({ ...g, ...patch }), false);
  const grant = readScheduleGrant(f.root, scheduleBinding(f.to, g.condition), f.to, g.condition);
  await assert.rejects(f.report(grant, "claim", null));
  await assert.rejects(f.report(grant, "activate_schedule", { session: randomUUID() }));
  await assert.rejects(f.report({ ...grant, capability: "0".repeat(64) }, "activate_schedule", { session: f.to }));
  assert.equal((await subscribeWatch(f.to, g.condition, { provider: "claude", id: f.to }, { root: f.root })).state, "denied");
  assert.deepEqual(f.rows(), []);
  await f.subscribe();
  f.policy = [{ ...g, intervalSeconds: 120 }];
  assert.throws(() => f.store.watches.provision());
  assert.deepEqual(f.rows(), []);
  await assert.rejects(f.report(grant, "activate_schedule", { session: f.to }));
  f.now += 120000;
  assert.equal(await f.observe(), false);
  assert.equal(f.sends, 0);
});

test("schedule worker rechecks policy before submission and keeps interrupted reservations unknown", async t => {
  const f = await fixture(t);
  await f.subscribe();
  f.now += 60000;
  f.send = async (_, body, options) => {
    assert.equal(body, scheduleNotice);
    await options.checkTarget(f.session);
    f.policy = [];
    await options.onHandle(f.handle, f.session);
    assert.fail("revocation permitted submission");
  };
  await assert.rejects(f.observe(), /authority changed/);
  assert.deepEqual(f.rows(), []);
  await f.restart();
  assert.equal(await f.observe(), false);
  f.policy = [f.g];
  f.now += 60000;
  assert.equal(f.rows()[0].state, "unknown");
  assert.equal(await f.observe(), false);
  assert.equal(f.proofs, 0);
});

test("reports-only broker accepts an activation and projects the schedule across restart", async t => {
  const f = await fixture(t);
  const record = path.join(f.root, "completion-policy.json");
  fs.writeFileSync(record, JSON.stringify({ v: 3, grants: [], schedules: [f.g] }));
  let service;
  t.after(() => service?.close());
  const launch = () => startCompletionBroker(f.root, { port: 0, publishHealth: true });
  service = await launch();
  const result = await subscribeWatch(f.to, f.g.condition, { provider: "codex", id: f.to }, { root: f.root, port: service.port });
  assert.equal(result.ok, true);
  await service.close();
  service = await launch();
  const health = readWatcher(f.root);
  assert.equal(health.state, "reports_only");
  assert.deepEqual(health.record.subscriptions, [{ id: f.g.condition, target: f.to, condition: "schedule", state: "waiting" }]);
  await service.close();
  fs.writeFileSync(record, JSON.stringify({ v: 1, grants: [] }));
  service = await launch();
  assert.deepEqual(readWatcher(f.root).record.subscriptions, []);
  await service.close();
});
