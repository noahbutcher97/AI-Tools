import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { startCompletionBroker } from "./completion-broker.mjs";
import { readWatcher, writeHeartbeat, validWatcherObservation } from "./watcher-health.mjs";
import { digest } from "./delivery-protocol.mjs";

const target = { id: "00000000-0000-4000-8000-000000000001", kind: "claude", pid: 11, startedAt: 19, addressable: true };

test("doctor sees only the broker's bounded projection and detects a stale heartbeat", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-health-"));
  const state = path.join(root,"completion-state"), health = path.join(root,"completion-health");
  fs.mkdirSync(state); fs.mkdirSync(health);
  const file = path.join(state,"jobs.sqlite");
  await initializeCompletionJobs(file);
  const policy = { v: 1,grants: [{ id: target.id, provider: target.kind, instance: digest(JSON.stringify([target.id,target.pid,target.startedAt])) }] };
  fs.writeFileSync(path.join(root,"completion-policy.json"), JSON.stringify(policy));
  const jobs = await openCompletionJobs(file, { permits: () => true });
  const grants = Array.from({ length: 35 }, () => jobs.issue(target, Date.now()+60000));
  const replacement = { ...target, startedAt: target.startedAt + 1 };
  const authorizedGrant = jobs.issue(replacement, Date.now()+60000);
  jobs.close();
  const broker = await startCompletionBroker(root,{ port: 0, publishHealth: true });
  t.after(async () => { await broker.close(); fs.rmSync(root,{ recursive: true, force: true }); });
  const obs = readWatcher(root);
  assert.equal(obs.state, "reports_only");
  assert.equal(obs.record.partial, true);
  assert.equal(obs.record.subscriptions.length,32);
  assert.equal(obs.record.policyRevision, digest(JSON.stringify(policy)));
  for (const entry of obs.record.subscriptions) {
    assert.deepEqual(Object.keys(entry).sort(), ["condition","id","state","target"]);
    assert.ok(grants.some(g => g.id === entry.id));
    assert.equal(entry.target,target.id); assert.equal(entry.state,"waiting");
  }
  for (const grant of grants) assert.ok(!JSON.stringify(obs).includes(grant.capability));
  const tick = Date.parse(obs.record.heartbeat);
  assert.equal(readWatcher(root,tick+15001).state, "stale");
  assert.equal(readWatcher(root,tick-1).state, "stale");
  assert.equal(validWatcherObservation({ ...obs, state: "watching" },tick), false);
  // Keep the raw ID and change the instance. A projection filtered by ID alone
  // would still expose the old jobs or let them exhaust the projection limit.
  const nextPolicy = { v: 1, grants: [{ id: target.id, provider: target.kind,
    instance: digest(JSON.stringify([target.id, target.pid, replacement.startedAt])) }] };
  fs.writeFileSync(path.join(root,"completion-policy.json"), JSON.stringify(nextPolicy));
  await broker.close();
  const final = readWatcher(root);
  assert.equal(final.state, "stopped");
  assert.equal(final.record.policyRevision, digest(JSON.stringify(nextPolicy)));
  assert.equal(final.record.partial, false);
  assert.deepEqual(final.record.subscriptions, [{ id: authorizedGrant.id, target: target.id, condition: "job_exit", state: "waiting" }]);
  const resumed = await startCompletionBroker(root, { port: 0, publishHealth: true });
  try {
    assert.deepEqual(readWatcher(root).record.subscriptions, final.record.subscriptions);
    fs.writeFileSync(path.join(root, "completion-policy.json"), "{");
  } finally { await resumed.close(); }
  const unavailable = readWatcher(root).record;
  assert.deepEqual(unavailable.subscriptions, []);
  assert.equal(unavailable.partial, true);
  assert.equal(unavailable.policyRevision, null);
});

test("a missing, oversized or overbroad record returns only unavailable", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-health-"));
  t.after(() => fs.rmSync(root,{ recursive: true, force: true }));
  const dir=path.join(root,"completion-health");
  fs.mkdirSync(dir);
  const unavailable = { state: "unavailable", record: null };
  assert.deepEqual(readWatcher(root),unavailable);
  const stamp=new Date().toISOString();
  const beat={ v:1, pid:10, startedAt:stamp, heartbeat:stamp, mode:"watching", policyRevision:null, partial:false, subscriptions:[] };
  writeHeartbeat(root,beat);
  assert.equal(readWatcher(root).state,"watching");
  for (const bad of [{ ...beat, capability:"fixture" }, { ...beat, subscriptions:[{ id:target.id, condition:"job_exit", target:target.id, state:"waiting", path:"fixture" }] }]) {
    assert.throws(()=>writeHeartbeat(root,bad));
    fs.writeFileSync(path.join(dir,"watcher.json"),JSON.stringify(bad));
    assert.deepEqual(readWatcher(root),unavailable);
  }
  fs.writeFileSync(path.join(dir,"watcher.json"),"x".repeat(8200));
  assert.deepEqual(readWatcher(root),unavailable);
});
