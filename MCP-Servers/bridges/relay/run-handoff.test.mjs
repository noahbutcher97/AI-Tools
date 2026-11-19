import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeCompletionJobs, instanceOf, openCompletionJobs } from "./completion-jobs.mjs";
import { loadJobPolicy, listenForJobReports, provisionRun, reportJob } from "./completion-broker.mjs";
import { prepareJobRequest } from "./completion-protocol.mjs";
import { availableGrant, publishRunHandoff } from "./run-handoff.mjs";
import { readRunGrant, startRun } from "./run-job.mjs";

const session = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const target = { kind: "claude", id: session, pid: process.pid, startedAt: 1000, addressable: true };
const binding = instanceOf(target);
const discover = async () => ({ targets: [target] });

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-grant-"));
  let store;
  t.after(() => { store?.close(); fs.rmSync(base, { force: true, recursive: true }); });
  const root = path.join(base, "CrossAgentRelay");
  const dir = path.join(root, "completion-grants");
  const file = path.join(dir, binding + ".json");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, "completion-state"));
  const db = path.join(root, "completion-state", "jobs.sqlite");
  await initializeCompletionJobs(db);
  const policy = grants => fs.writeFileSync(path.join(root, "completion-policy.json"), JSON.stringify({ v: 1, grants }));
  const row = { id: session, instance: binding, provider: "claude" };
  policy([row]);
  const until = Date.now() + 60000;
  const issue = () => provisionRun(root, session, "2", new Date(until).toISOString());
  store = await openCompletionJobs(db, { permits: loadJobPolicy(root) });
  return { base, root, dir, file, db, policy, row, until, issue, store };
}

test("Codex thread-status grants bind claims to the provider, thread and local broker", async t => {
  const f = await fixture(t);
  const peer = await fixture(t);
  const row = { id: session, provider: "codex", scope: "thread-status" };
  const thread = { id: session, kind: "codex", addressable: true, pid: null, startedAt: null };
  assert.throws(() => instanceOf(thread), /unknown session instance/);
  f.policy([{ ...row, scope: "private-tail" }]);
  await assert.rejects(f.issue());
  f.policy([row]);
  peer.policy([row]);
  await f.issue();
  const listener = await listenForJobReports(f.store.acceptFrame, { port: 0 });
  try {
    const options = { root: f.root, port: listener.port, provider: "codex", discover: async () => ({ targets: [thread] }) };
    const grant = await availableGrant(session, reportJob, options);
    const claim = prepareJobRequest(grant, "claim_run", { session, provider: "codex" });
    for (const wrong of [{ session }, { session: other, provider: "codex" }]) {
      assert.throws(() => f.store.acceptFrame(prepareJobRequest(grant, "claim_run", wrong).frame));
    }
    assert.throws(() => f.store.acceptFrame({ ...claim.frame, event: { session } }));
    assert.throws(() => peer.store.acceptFrame(claim.frame));
    await assert.rejects(availableGrant(session, reportJob, { ...options, provider: "claude" }));
    const result = await startRun([process.execPath, "-e", "process.exit(23)"], { id: session, provider: "codex" }, Readable.from([]), options);
    assert.deepEqual(result, { id: grant.id, state: "started" });
    const end = Date.now() + 5000;
    const state = () => f.store.subscriptions().subscriptions.find(s => s.id === grant.id)?.state;
    while (state() === "claimed" && Date.now() < end) await delay(25);
    assert.equal(state(), "ready");
    assert.throws(() => f.store.acceptFrame(claim.frame));
    f.policy([]);
    await assert.rejects(availableGrant(session, reportJob, options));
  } finally { await listener.close(); }
});

test("a reserved handoff resumes publication once and cannot mint replacements", async t => {
  const f = await fixture(t);
  const retry = () => f.store.provision(session, binding, 2, f.until, () => { throw Error("interrupted"); });
  assert.throws(retry, /interrupted/);
  assert.equal(fs.existsSync(f.file), false);
  const reserved = f.store.subscriptions();
  assert.equal(reserved.subscriptions.length, 2);
  const crashAfterPublish = (...args) => { publishRunHandoff(f.root, ...args); throw Error("interrupted"); };
  assert.throws(() => f.store.provision(session, binding, 2, f.until, crashAfterPublish), /interrupted/);
  assert.deepEqual(await f.issue(), { count: 2, validUntil: f.until });
  const bytes = fs.readFileSync(f.file);
  await f.issue();
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.deepEqual(f.store.subscriptions(), reserved);
  await assert.rejects(provisionRun(f.root, session, "1", new Date(f.until).toISOString()));
  fs.writeFileSync(f.file, "{}");
  await assert.rejects(f.issue());
  assert.equal(fs.readFileSync(f.file, "utf8"), "{}");
  fs.unlinkSync(f.file);
  await assert.rejects(f.issue());
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.store.subscriptions(), reserved);
});

test("only a single authorized binding can be provisioned and each run claim is session-bound", async t => {
  const f = await fixture(t);
  for (const rows of [[], [f.row, f.row], [{ ...f.row, provider: "other" }]]) {
    f.policy(rows);
    await assert.rejects(f.issue());
    assert.equal(f.store.subscriptions().subscriptions.length, 0);
    assert.deepEqual(fs.readdirSync(f.dir), []);
  }
  f.policy([f.row]);
  await f.issue();
  const [g] = JSON.parse(fs.readFileSync(f.file)).grants;
  const frame = (op, event) => prepareJobRequest(g, op, event).frame;
  const peek = frame("available_run", { session });
  f.store.acceptFrame(peek);
  f.store.acceptFrame(peek);
  assert.throws(() => f.store.acceptFrame({ ...peek, op: "claim_run" }));
  assert.throws(() => f.store.acceptFrame(frame("available_run", { session: other })));
  assert.throws(() => f.store.acceptFrame(frame("claim", null)));
  assert.throws(() => f.store.complete(g.id, g.capability, { code: 0, signal: null }));
  f.policy([]);
  assert.throws(() => f.store.acceptFrame(peek));
  f.policy([f.row]);
  const claim = frame("claim_run", { session });
  f.store.acceptFrame(claim);
  assert.throws(() => f.store.acceptFrame(peek));
  assert.throws(() => f.store.acceptFrame(claim));
});

test("ambiguous, redirected, malformed and expired handoffs cause zero broker calls", async t => {
  const f = await fixture(t);
  await f.issue();
  const batch = JSON.parse(fs.readFileSync(f.file));
  let calls = 0;
  const lookup = opts => availableGrant(session, async () => { calls++; }, { root: f.root, discover, ...opts });
  for (const targets of [[], [target, target], [{ ...target, kind: "codex" }], [{ ...target, startedAt: 1001 }]]) {
    await assert.rejects(lookup({ discover: async () => ({ targets }) }));
  }
  await assert.rejects(lookup({ now: () => f.until }));
  for (const value of [{ ...batch, session: other }, { ...batch, instance: "a".repeat(64) },
    { ...batch, grants: [batch.grants[0], batch.grants[0]] }, { ...batch, grants: [null] },
    { ...batch, extra: true }, "x".repeat(4097)]) {
    fs.writeFileSync(f.file, JSON.stringify(value));
    await assert.rejects(lookup());
  }
  const alias = path.join(f.base, "alias");
  fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(lookup({ root: alias }), /redirected/);
  assert.equal(calls, 0);
  let fallback = 0;
  await assert.rejects(readRunGrant(Readable.from(["{"]), () => { fallback++; }));
  assert.equal(fallback, 0);
  assert.equal(await readRunGrant({ isTTY: true }, () => "tty"), "tty");
});

test("empty stdin launches two literal commands with two grants and refuses a third", async t => {
  const f = await fixture(t);
  await f.issue();
  const completed = [];
  const listener = await listenForJobReports(frame => {
    const ack = f.store.acceptFrame(frame);
    if (frame.op === "complete") completed.push(frame.event.code);
    return ack;
  }, { port: 0 });
  try {
    for (const code of [23, 0]) {
      const result = await startRun([process.execPath, "-e", "process.exit(" + code + ")"],
        { id: session, provider: "claude" }, Readable.from([]), { root: f.root, discover, port: listener.port });
      assert.equal(result.state, "started");
    }
    await assert.rejects(availableGrant(session, reportJob, { root: f.root, discover, port: listener.port }));
    const end = Date.now() + 5000;
    while (completed.length < 2 && Date.now() < end) await delay(25);
    assert.deepEqual(completed.sort(), [0, 23]);
  } finally { await listener.close(); }
});

test("v2 stores keep outstanding grants through the handoff migration", async t => {
  const f = await fixture(t);
  const existing = f.store.issue(target, f.until);
  const db = new DatabaseSync(f.db);
  try { db.exec("DROP TABLE grant_handoffs; ALTER TABLE jobs DROP COLUMN run_only; PRAGMA user_version=2"); }
  finally { db.close(); }
  const upgraded = await openCompletionJobs(f.db, { permits: loadJobPolicy(f.root) });
  try {
    upgraded.acceptFrame(prepareJobRequest(existing, "claim", null).frame);
    assert.equal(await upgraded.dispatch(existing.id), "claimed");
    await f.issue();
  } finally { upgraded.close(); }
});

// The real CLI uses the installed broker port. Run explicitly on an otherwise
// idle test installation so ordinary test runs never occupy the service port.
test("installed-port CLI smoke uses a synthetic profile and an empty input stream", {
  skip: process.platform !== "win32" || process.env.RELAY_TEST_RUN_CLI !== "1",
}, async t => {
  const f = await fixture(t);
  await f.issue();
  const profile = path.join(f.base, "profile");
  const registry = path.join(profile, ".claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, process.pid + ".json"), JSON.stringify({
    sessionId: session, pid: process.pid, startedAt: target.startedAt, name: "fixture", messagingSocketPath: "fixture",
  }));
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: session, USERPROFILE: profile, HOME: profile };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const outcomes = [];
  const server = await listenForJobReports(frame => {
    const ack = f.store.acceptFrame(frame);
    if (frame.op === "complete") outcomes.push(frame.event.code);
    return ack;
  });
  const invoke = code => {
    // Windows restores ProgramFiles on process creation. Set the fixture root
    // inside this test process before the ordinary CLI module loads.
    const init = "data:text/javascript," + encodeURIComponent("process.env.ProgramFiles=" + JSON.stringify(f.base));
    const command = promisify(execFile)(process.execPath, ["--import", init, cli, "run", "--", process.execPath, "-e", "process.exit(" + code + ")"],
      { env, windowsHide: true, timeout: 10000 });
    command.child.stdin.end();
    return command;
  };
  try {
    for (const code of [23, 0]) assert.equal(JSON.parse((await invoke(code)).stdout).state, "started");
    await assert.rejects(invoke(1), error => error.code === 1 && /No usable pre-issued/.test(error.stderr));
    const limit = Date.now() + 5000;
    while (outcomes.length < 2 && Date.now() < limit) await delay(25);
    assert.deepEqual(outcomes.sort(), [0, 23]);
  } finally { await server.close(); }
});
