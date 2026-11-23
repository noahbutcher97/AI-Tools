import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sampleInstalledBranch } from "./branch-observation.mjs";
import { parseArgs } from "./client.mjs";
import { listenForJobReports, reportJob, startCompletionBroker } from "./completion-broker.mjs";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { changeNotice, scheduleNotice } from "./completion-protocol.mjs";
import { sessionDelivery } from "./completion-session.mjs";
import { readScheduleGrant } from "./run-handoff.mjs";
import { branchBinding, fileBinding, scheduleBinding, validBranchWatch, validFileWatch, validSchedule } from "./schedule-watch.mjs";
import { subscribeWatch } from "./watch-client.mjs";
import { readWatcher } from "./watcher-health.mjs";

async function fixture(t, fileWatch = false, credential = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-schedule-"));
  const file = path.join(root, "completion-state", "jobs.sqlite");
  for (const dir of ["completion-state","completion-grants","completion-health"]) fs.mkdirSync(path.join(root, dir));
  await initializeCompletionJobs(file);
  const target = randomUUID(), start = Date.now();
  const common = { condition: randomUUID(), target, provider: "codex", expiresAt: new Date(start + 86400000).toISOString() };
  const g = fileWatch === "branch" ? { ...common, scope: "thread-branch-change", ref: "refs/heads/fixture",
    endpoint: "https://" + ["fixture","invalid"].join(".") + "/fixture/repo", credential } :
    fileWatch ? { ...common, scope: "thread-file-change", volume: randomUUID(),
    directory: "fixture", rootId: "b".repeat(48), file: "item" } : { ...common, scope: "thread-schedule",
    startsAt: new Date(start).toISOString(), intervalSeconds: 60 };
  const session = { id: target, kind: "codex", addressable: true, pid: null, startedAt: null };
  const handle = "local-proof." + "a".repeat(48);
  const f = { root, file, start, now: start, g, session, handle, policy: [g], sends: 0, proofs: 0,
    proof: { state: "pending", to: target }, to: target };
  let listener;
  f.send = async (to, body, options) => {
    assert.equal(to, target);
    assert.equal(body, fileWatch ? changeNotice : scheduleNotice);
    assert.equal(options.allowDelegate, false);
    await options.checkTarget(session);
    await options.onHandle(handle, session);
    f.sends++;
    return { state: "pending" };
  };
  f.stop = async () => {
    await listener?.close();
    f.store?.close();
    listener = undefined;
    f.store = undefined;
  };
  f.restart = async () => {
    await f.stop();
    f.store = await openCompletionJobs(file, { now: () => f.now, schedules: { root, policy: () => f.policy,
      sampleFile: fileWatch ? grant => f.sample(grant) : undefined,
      sampleBranch: fileWatch === "branch" ? (...args) => f.readRef(...args) : undefined },
      send: (...args) => f.send(...args), status: async h => { assert.equal(h, handle); f.proofs++; return f.proof; } });
    f.store.watches.provision();
    listener = await listenForJobReports(f.store.acceptFrame, { port: 0 });
  };
  t.after(async () => { await f.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  f.subscribe = (id = g.condition, to = target) => subscribeWatch(to, id, { id: to, provider: "codex" }, { root, port: listener.port });
  f.observe = async () => { await f.store.watches.pollChanges(); return f.store.watches.dispatchDue(); };
  f.rows = () => f.store.watches.subscriptions(f.policy);
  f.report = (grant, op, event) => reportJob(grant, op, event, { port: listener.port });
  await f.restart();
  return f;
}

test("a restored watch with an unreadable witness pauses while an independent grant continues", async t => {
  const f = await fixture(t, true);
  const healthy = { ...f.g, condition: randomUUID(), file: "other" };
  f.policy.push(healthy);
  f.store.watches.provision();
  for (const g of f.policy) assert.equal((await f.subscribe(g.condition)).ok, true);
  const db = new DatabaseSync(f.file);
  try { db.prepare("UPDATE broker_seals SET mac='' WHERE kind='file_samples' AND id=?").run(f.g.condition); }
  finally { db.close(); }
  await f.restart();
  assert.deepEqual(f.rows(), [
    { id: f.g.condition, target: f.to, condition: "file", state: "paused", reason: "stored_state_unverified" },
    { id: healthy.condition, target: f.to, condition: "file", state: "waiting" },
  ]);
  const opened = [];
  f.sample = g => { opened.push(g.condition); return "absent"; };
  assert.equal((await f.subscribe(f.g.condition)).ok, false);
  await f.observe();
  assert.deepEqual(opened, [healthy.condition]);
  assert.equal(f.sends, 0);
  assert.equal(f.proofs, 0);
  f.policy = [healthy];
  assert.deepEqual(f.rows().map(r => r.id), [healthy.condition]);
});

for (const state of ["unknown", "observing"]) {
  test("a paused change watch keeps its " + state + " notice reserved for its destination", async t => {
    const f = await fixture(t, true);
    assert.equal((await f.subscribe()).ok, true);
    f.sample = () => "absent";
    await f.observe();
    f.now += 10000;
    f.sample = () => "a".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
    if (state === "unknown") f.send = async () => ({ state: "unknown" });
    assert.equal(await f.observe(), true);
    assert.equal(f.rows()[0].state, state);

    await f.stop();
    const db = new DatabaseSync(f.file);
    try { db.prepare("UPDATE broker_seals SET mac='' WHERE kind='file_samples' AND id=?").run(f.g.condition); }
    finally { db.close(); }
    const same = { condition: randomUUID(), target: f.to, provider: "codex", scope: "thread-schedule",
      startsAt: new Date(f.now).toISOString(), intervalSeconds: 60, expiresAt: f.g.expiresAt };
    const other = { ...same, condition: randomUUID(), target: randomUUID() };
    f.policy.push(same, other);
    await f.restart();
    for (const grant of [same, other]) assert.equal((await f.subscribe(grant.condition, grant.target)).ok, true);
    const observations = [], sent = [];
    f.sample = grant => { observations.push(grant.condition); return "absent"; };
    f.send = async (target, body, options) => {
      assert.equal(body, scheduleNotice);
      await options.onHandle(f.handle, { ...f.session, id: target });
      sent.push(target);
      return { state: "pending" };
    };
    f.now += 60000;
    assert.equal(await f.observe(), true);
    assert.equal(await f.observe(), false);
    assert.deepEqual(sent, [other.target]);
    assert.deepEqual(observations, []);
    assert.equal(f.proofs, 0);
    assert.deepEqual(f.rows().map(row => row.state), ["paused", "waiting", "observing"]);
    assert.equal(f.rows()[0].reason, "stored_state_unverified");
  });
}

test("restoring an older watch cursor cannot replace the original pending proof", async t => {
  const f = await fixture(t);
  await f.subscribe();
  f.now += 60000;
  await f.observe();
  assert.equal(f.sends, 1);
  const db = new DatabaseSync(f.file);
  try { db.prepare("UPDATE schedule_watches SET cursor=0 WHERE condition=?").run(f.g.condition); }
  finally { db.close(); }
  await f.restart();
  f.now += 60000;
  assert.equal(await f.observe(), false);
  assert.equal(f.sends, 1);
  assert.equal(f.proofs, 0);
  assert.equal(f.rows()[0].reason, "stored_state_unverified");
});

test("a broker keeps a consumed one-shot grant spent after restoring its older signed data", async t => {
  const f = await fixture(t, true);
  await f.subscribe();
  let reads = 0;
  let observed = "absent";
  f.sample = () => { reads++; return observed; };
  await f.observe();
  await f.stop();
  const backup = path.join(f.root, "state-backup");
  fs.copyFileSync(f.file, backup);
  await f.restart();
  f.now += 10000;
  observed = "a".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
  await f.observe();
  assert.equal(f.sends, 1);
  f.proof = { state: "delivered", to: f.to };
  f.now += 10000;
  await f.observe();
  assert.deepEqual(f.rows(), []);
  assert.equal(f.proofs, 1);
  await f.stop();
  fs.copyFileSync(backup, f.file);
  await f.restart();
  assert.equal(f.rows()[0].reason, "stored_state_unverified");
  f.now += 10000;
  await f.observe();
  assert.deepEqual({ reads, calls: f.sends, proofs: f.proofs }, { reads: 2, calls: 1, proofs: 1 });
  assert.equal((await f.subscribe()).ok, false);
});

test("a missing independent witness refuses startup without blessing retained state", async t => {
  const f = await fixture(t);
  await f.subscribe();
  await f.stop();
  const witness = f.file + ".witness";
  fs.renameSync(witness, witness + ".offline");
  await assert.rejects(f.restart);
  assert.equal(fs.existsSync(witness), false);
  assert.equal(f.sends, 0);
  fs.renameSync(witness + ".offline", witness);
  await f.restart();
  assert.equal(f.rows()[0].state, "waiting");
});

test("restored schema names cannot alias the broker witness under SQLite identifier casing", async t => {
  const f = await fixture(t);
  await f.subscribe();
  await f.stop();
  const db = new DatabaseSync(f.file);
  try { db.exec("CREATE TABLE Current_Seals (fixture INTEGER)"); }
  finally { db.close(); }
  await assert.rejects(f.restart, /invalid broker schema/);
  assert.equal(f.sends, 0);
  assert.equal(f.proofs, 0);
});

test("separately granted file changes coalesce and exhaust one fixed notice across writer resumes", async t => {
  const f = await fixture(t, true);
  const other = { ...f.g, condition: randomUUID(), file: "other" };
  f.policy.push(other);
  f.store.watches.provision();
  let opens = 0;
  let value = "a".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
  f.sample = () => { opens++; return value; };
  await f.observe();
  assert.equal(opens, 0);
  for (const g of f.policy) assert.equal((await f.subscribe(g.condition)).state, "subscribed");
  await f.observe();
  assert.equal(opens, 2);
  assert.equal(f.sends, 0);
  await f.restart();
  f.now += 10000;
  value = "invalid";
  await f.observe();
  assert.equal(f.sends, 0);
  f.now += 10000;
  value = "c".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
  await f.observe();
  assert.equal(f.sends, 1);
  assert.deepEqual(f.rows().map(s => s.state), ["observing","observing"]);
  await f.restart();
  f.now += 10000;
  f.proof = { to: f.to, state: "delivered" };
  await f.observe();
  assert.deepEqual(f.rows(), []);
  const observed = opens;
  await f.restart();
  assert.equal((await f.subscribe()).ok, true);
  f.now += 60000;
  await f.observe();
  assert.equal(opens, observed);
  assert.equal(f.sends, 1);
});

test("a file watch rechecks the resource and target after sampling and rejects clock authority", async t => {
  const f = await fixture(t, true);
  for (const patch of [{ directory: ".." }, { file: "part/../item" }, { file: "a:b" }, { file: "item\\other" },
    { file: "a//b" }, { volume: "other" }, { rootId: "missing" }, { body: "private" }]) {
    assert.equal(validFileWatch({ ...f.g, ...patch }), false);
  }
  const grant = readScheduleGrant(f.root, fileBinding(f.to, f.g.condition), f.to, f.g.condition);
  await assert.rejects(f.report(grant, "activate_schedule", { session: f.to }));
  await assert.rejects(f.report(grant, "activate_file", { session: randomUUID() }));
  await f.subscribe();
  let opens = 0;
  const fingerprint = "a".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
  f.sample = () => { opens++; return fingerprint; };
  f.policy = [{ ...f.g, file: "changed" }];
  await f.observe();
  assert.equal(opens, 0);
  f.policy = [f.g];
  await f.observe();
  assert.equal(opens, 1);
  f.now += 10000;
  f.sample = () => { opens++; f.policy = []; return fingerprint.replace(/^a/, "b"); };
  await f.observe();
  assert.equal(opens, 2);
  assert.equal(f.sends, 0);
  assert.deepEqual(f.rows(), []);
});

test("confirmed disappearance spends one notice and unavailable storage spends none", async t => {
  const f = await fixture(t, true);
  await f.subscribe();
  f.sample = () => "a".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
  await f.observe();
  f.sample = () => { throw Error("unavailable"); };
  f.now += 10000;
  await f.observe();
  assert.equal(f.sends, 0);
  f.sample = () => "absent";
  f.now += 10000;
  await f.observe();
  assert.equal(f.sends, 1);
  f.proof = { state: "delivered", to: f.to };
  f.now += 10000;
  await f.observe();
  assert.deepEqual(f.rows(), []);
});

test("installed branch observation rechecks the active grant after pin verification", async t => {
  const f = await fixture(t, "branch");
  const pin = createHash("sha256").update("fixture").digest("hex");
  for (const name of ["completion-git.json", "git.exe", "git-remote-https.exe"]) {
    fs.writeFileSync(path.join(f.root, name), "fixture");
  }
  const profile = { image: path.join(f.root, "git.exe"), execPath: f.root, cwd: f.root,
    windows: f.root, profileHash: pin, imageHash: pin, transportHash: pin };
  let launches = 0;
  const run = async () => {
    launches++;
    return { code: 0, stdout: "a".repeat(40) + "\t" + f.g.ref + "\n" };
  };
  let change;
  f.readRef = (grant, signal, canObserve) => {
    const result = sampleInstalledBranch(f.root, profile, grant, signal, { canObserve, run });
    // The sampler yields on its first asynchronous file open. Change the
    // authority before any of the three pin reads can complete.
    change();
    return result;
  };
  assert.equal((await f.subscribe()).ok, true);
  change = () => {};
  await f.observe();
  assert.equal(launches, 1);
  launches = 0;
  for (change of [
    () => { f.policy = []; },
    () => { f.policy = [{ ...f.g, ref: "refs/heads/other" }]; },
    () => { f.now = Date.parse(f.g.expiresAt); },
  ]) {
    f.policy = [f.g];
    f.now += 60000;
    await f.observe();
    assert.equal(launches, 0);
    assert.equal(f.sends, 0);
  }
});

test("branch polling excludes failed observations, pins its resource and coalesces a file change", async t => {
  const f = await fixture(t, "branch");
  assert.equal(validBranchWatch({ ...f.g, credential: randomUUID() }), false);
  const file = { condition: randomUUID(), target: f.to, provider: "codex", scope: "thread-file-change", volume: randomUUID(),
    directory: "fixture", rootId: "a".repeat(48), file: "item", expiresAt: f.g.expiresAt };
  f.policy.push(file);
  f.store.watches.provision();
  let revision = "a".repeat(40), metadata = "absent", reads = 0;
  f.sample = () => metadata;
  f.readRef = g => { reads++; assert.deepEqual(g, f.g); return revision; };
  await f.observe();
  assert.equal(reads, 0);
  const grant = readScheduleGrant(f.root, branchBinding(f.to, f.g.condition), f.to, f.g.condition);
  await assert.rejects(f.report(grant, "activate_file", { session: f.to }));
  for (const g of f.policy) assert.equal((await f.subscribe(g.condition)).ok, true);
  await f.observe();
  assert.equal(reads, 1);
  f.now += 60000;
  f.policy[0] = { ...f.g, ref: "refs/heads/other" };
  await f.observe();
  assert.equal(reads, 1);
  f.policy[0] = f.g;
  revision = "absent";
  await f.observe();
  assert.equal(f.sends, 0);
  await f.restart();
  f.now += 60000;
  revision = "b".repeat(40);
  metadata = "b".repeat(48) + ":" + "0".repeat(16) + ":" + "1".repeat(16);
  await f.observe();
  assert.equal(f.sends, 1);
  assert.deepEqual(f.rows().map(r => r.state), ["observing","observing"]);
  f.proof = { state: "delivered", to: f.to };
  f.now += 10000;
  await f.observe();
  assert.deepEqual(f.rows(), []);
  assert.equal(f.sends, 1);
});

test("a private branch moving alone wakes once and waits for proof from the granted thread", async t => {
  const f = await fixture(t, "branch", randomUUID());
  let revision = "a".repeat(40);
  f.readRef = (grant, signal, canObserve) => {
    assert.equal(canObserve(), true);
    assert.deepEqual(grant, f.g);
    return revision;
  };
  assert.equal((await f.subscribe()).state, "subscribed");
  await f.observe();
  f.now += 60000;
  await f.observe();
  assert.equal(f.sends, 0);

  revision = "b".repeat(40);
  f.now += 60000;
  await f.observe();
  assert.equal(f.sends, 1);
  assert.equal(f.rows()[0].state, "observing");
  await f.restart();
  for (const proof of [{ state: "pending", to: f.to }, { state: "delivered", to: randomUUID() }]) {
    f.now += 60000;
    f.proof = proof;
    await f.observe();
    assert.equal(f.rows()[0].state, "observing");
    assert.equal(f.sends, 1);
  }
  assert.equal(f.proofs, 2);
  f.proof = { state: "delivered", to: f.to };
  f.now += 60000;
  await f.observe();
  assert.deepEqual(f.rows(), []);
  await f.restart();
  revision = "c".repeat(40);
  f.now += 60000;
  await f.observe();
  assert.equal(f.sends, 1);
});

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
  f.store.watches.provision();
  assert.deepEqual(f.rows(), [{ id: g.condition, target: g.target, condition: "schedule", state: "paused", reason: "grant_changed" }]);
  await assert.rejects(f.report(grant, "activate_schedule", { session: f.to }));
  f.now += 120000;
  assert.equal(await f.observe(), false);
  assert.equal(f.sends, 0);
});

for (const interruption of ["shutdown", "revocation"]) {
  test("an unsent watch releases its reservation after " + interruption + " before handle capture", async t => {
    const f = await fixture(t);
    const other = { ...f.g, condition: randomUUID() };
    f.policy.push(other);
    f.store.watches.provision();
    for (const g of f.policy) assert.equal((await f.subscribe(g.condition)).ok, true);
    f.now += 60000;
    const controller = new AbortController();
    const commands = [];
    const normalSend = f.send;
    f.send = sessionDelivery(f.root, operation => operation({
      write(frame) { commands.push(frame.op); },
      read() {
        if (commands.at(-1) === "send") return { op: "target", target: f.session };
        if (interruption === "shutdown") controller.abort();
        else f.policy = [other];
        return { op: "handle", handle: f.handle };
      },
    })).send;
    assert.equal(await f.store.watches.dispatchDue(controller.signal), true);
    assert.deepEqual(commands, ["send","capture"]);
    assert.ok(f.rows().every(r => r.state === "waiting"));
    await f.restart();
    assert.equal(f.rows().length, interruption === "shutdown" ? 2 : 1);
    f.send = normalSend;
    f.now += 10000;
    await f.observe();
    assert.equal(f.sends, 1);
    if (interruption === "revocation") {
      f.policy = [f.g, other];
      assert.deepEqual(f.rows().map(r => r.state), ["waiting","observing"]);
    }
  });
}

test("a failed result after handle reservation leaves only the original proof eligible", async t => {
  const f = await fixture(t);
  await f.subscribe();
  f.now += 60000;
  f.send = async (_, __, options) => {
    await options.onHandle(f.handle, f.session);
    return { state: "dispatch_failed" };
  };
  await f.observe();
  assert.equal(f.rows()[0].state, "observing");
  await f.restart();
  f.send = assert.fail;
  f.now += 10000;
  await f.observe();
  assert.equal(f.proofs, 1);
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

test("a protected v6 branch grant activates by condition ID and keeps its credential reference private", async t => {
  const f = await fixture(t, "branch", randomUUID());
  const file = path.join(f.root, "completion-policy.json");
  const policy = { v: 5, grants: [], schedules: [], files: [], branches: [f.g] };
  const launch = () => startCompletionBroker(f.root, { port: 0, publishHealth: true, sampleBranch: assert.fail });
  fs.writeFileSync(file, JSON.stringify(policy));
  await assert.rejects(launch(), /invalid branch authority/);
  policy.v = 6;
  fs.writeFileSync(file, JSON.stringify(policy));
  let service = await launch();
  t.after(() => service.close());
  const request = { root: f.root, port: service.port };
  assert.equal((await subscribeWatch(f.to, f.g.condition, { provider: "codex", id: f.to }, request)).ok, true);
  await service.close();
  service = await launch();
  assert.deepEqual(readWatcher(f.root).record.subscriptions, [{ id: f.g.condition, target: f.to, condition: "branch", state: "waiting" }]);
  await service.close();
  policy.branches[0] = { ...f.g, credential: randomUUID() };
  fs.writeFileSync(file, JSON.stringify(policy));
  service = await launch();
  assert.deepEqual(readWatcher(f.root).record.subscriptions, [
    { id: f.g.condition, target: f.to, condition: "branch", state: "paused", reason: "grant_changed" },
  ]);
  await service.close();
  policy.branches[0].credential = "../record";
  fs.writeFileSync(file, JSON.stringify(policy));
  await assert.rejects(launch(), /invalid branch authority/);
});

for (const kind of ["file", "branch", "schedule"]) {
  test("reports-only broker projects an active " + kind + " across restart", async t => {
    const f = await fixture(t, kind === "branch" ? "branch" : kind === "file");
    const record = path.join(f.root, "completion-policy.json");
    const policy = kind === "branch" ? { v: 5, grants: [], schedules: [], files: [], branches: [f.g] } :
      kind === "file" ? { v: 4, grants: [], schedules: [], files: [f.g] } : { v: 3, grants: [], schedules: [f.g] };
    fs.writeFileSync(record, JSON.stringify(policy));
    let service;
    t.after(() => service?.close());
    const launch = () => startCompletionBroker(f.root, { port: 0, publishHealth: true, sampleFile: assert.fail });
    service = await launch();
    const result = await subscribeWatch(f.to, f.g.condition, { provider: "codex", id: f.to }, { root: f.root, port: service.port });
    assert.equal(result.ok, true);
    await service.close();
    service = await launch();
    const health = readWatcher(f.root);
    assert.equal(health.state, "reports_only");
    assert.deepEqual(health.record.subscriptions, [{ id: f.g.condition, target: f.to, condition: kind, state: "waiting" }]);
    await service.close();
    fs.writeFileSync(record, JSON.stringify({ v: 1, grants: [] }));
    service = await launch();
    assert.deepEqual(readWatcher(f.root).record.subscriptions, []);
    await service.close();
  });
}
