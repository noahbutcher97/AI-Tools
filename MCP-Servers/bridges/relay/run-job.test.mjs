import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once, EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./client.mjs";
import { listenForJobReports } from "./completion-broker.mjs";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { prepareJobRequest } from "./completion-protocol.mjs";
import { observeCommand, readRunGrant, startRun } from "./run-job.mjs";

const session = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const target = { id: session, kind: "claude", addressable: true, pid: 42, startedAt: 10 };
const identity = { provider: "claude", id: session };
const grant = { id: other, capability: "c".repeat(64) };
const input = g => Readable.from([JSON.stringify(g)]);

test("run preserves literal arguments and refuses an absent or oversized grant", async () => {
  const argv = ["fixture", "", "--json", "a b", "&&", '"'];
  assert.deepEqual(parseArgs(["run", "--", ...argv]), { command: "run", argv });
  assert.throws(() => parseArgs(["run", "fixture"]));
  assert.throws(() => parseArgs(["run", "--"]));
  await assert.rejects(readRunGrant(Readable.from([])), /grant/);
  await assert.rejects(readRunGrant(input({ ...grant, path: "fixture" })), /grant/);
  await assert.rejects(readRunGrant(Readable.from([" ".repeat(257), JSON.stringify(grant)])), /grant/);
  await assert.rejects(startRun(argv, { id: session, provider: "codex" }, input(grant)), /unavailable/);
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: session };
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  const r = spawnSync(process.execPath, [cli, "run", "--", "fixture"], { env, input: "{}", encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /private job grant/);
  assert.equal(r.stdout, "");
});

test("a lost completion acknowledgement retries only the identical status after one spawn", async () => {
  const claims = [], reports = [], notices = [];
  let launched = 0;
  const done = await observeCommand({ grant, session, argv: ["fixture", "a b"] }, state => notices.push(state), {
    report: async (g, op, event) => {
      if (op === "claim_run") claims.push(event.session);
      else {
        reports.push([op, event]);
        if (reports.length === 1) throw Error("fixture lost acknowledgement");
      }
    },
    pause: async () => {},
    launch: (file, argv, opts) => {
      launched++;
      assert.equal(file, "fixture");
      assert.deepEqual(argv, ["a b"]);
      assert.equal(opts.shell, false);
      const child = new EventEmitter();
      queueMicrotask(() => { child.emit("spawn"); child.emit("exit", null, "SIGTERM"); });
      return child;
    },
  });
  assert.equal(done, true);
  assert.deepEqual(claims, [session]);
  assert.equal(launched, 1);
  assert.deepEqual(notices, ["started"]);
  assert.deepEqual(reports, Array(2).fill(["complete", { code: null, signal: "SIGTERM" }]));
});

test("no command starts without a verified claim or after a pre-launch disconnect", async () => {
  for (const denied of [true, false]) {
    const calls = [], notices = [];
    await observeCommand({ grant, session, argv: ["fixture"] }, state => notices.push(state), {
      connected: () => false, launch: assert.fail, report: async (_, op) => {
        calls.push(op);
        if (denied) throw Error("fixture");
      },
    });
    assert.deepEqual(calls, denied ? ["claim_run"] : ["claim_run", "start_failed"]);
    assert.deepEqual(notices, ["not_started"]);
  }
});

test("the detached observer outlives the calling process and reports exactly the child's exit", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-run-"));
  const file = path.join(root, "jobs.sqlite");
  await initializeCompletionJobs(file);
  const store = await openCompletionJobs(file, { permits: id => id === session, send: assert.fail });
  const first = store.issue(target, Date.now() + 30000);
  const second = store.issue(target, Date.now() + 30000);
  const outcomes = [];
  const listener = await listenForJobReports(frame => {
    const reply = store.acceptFrame(frame);
    if (["complete", "start_failed"].includes(frame.op)) outcomes.push([frame.id, frame.op, frame.event]);
    return reply;
  }, { port: 0 });
  t.after(async () => {
    await listener.close();
    store.close();
    fs.rmSync(root, { force: true, recursive: true });
  });
  const { port } = listener;
  const claim = prepareJobRequest(first, "claim_run", { session: other });
  assert.throws(() => store.acceptFrame(claim.frame));
  assert.throws(() => store.acceptFrame({ ...claim.frame, event: { session } }));
  assert.equal(await store.dispatch(first.id), "waiting");

  const failed = await startRun([path.join(root, "absent-executable")], identity, input(second), { port });
  assert.deepEqual(failed, { id: second.id, state: "not_started" });

  const marker = path.join(root, "release");
  const argv = [process.execPath, "-e", `
    const fs = require("node:fs");
    const timer = setInterval(() => {
      if (fs.existsSync(process.argv[1])) {
        clearInterval(timer); clearTimeout(limit);
        process.exitCode = process.argv[2] === "a b && c" ? 23 : 1;
      }
    }, 25);
    const limit = setTimeout(() => process.exit(2), 8000);`, marker, "a b && c"];
  const source = `import { startRun } from ${JSON.stringify(new URL("./run-job.mjs", import.meta.url).href)};
    console.log(JSON.stringify(await startRun(${JSON.stringify(argv)}, ${JSON.stringify(identity)}, process.stdin, {port:${port}})));`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "ignore"], timeout: 5000 });
  const closed = once(parent, "close");
  let stdout = "";
  parent.stdout.on("data", chunk => { stdout += chunk; });
  parent.stdin.end(JSON.stringify(first));
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(JSON.parse(stdout), { id: first.id, state: "started" });
  assert.equal(await store.dispatch(first.id), "claimed");
  fs.writeFileSync(marker, "");
  const until = Date.now() + 5000;
  while (outcomes.length < 2 && Date.now() < until) await delay(25);
  assert.deepEqual(outcomes, [[second.id, "start_failed", null], [first.id, "complete", { code: 23, signal: null }]]);
  const retry = await startRun(argv, identity, input(first), { port });
  assert.deepEqual(retry, { id: first.id, state: "not_started" });
  assert.equal(await store.dispatch(second.id), "start_failed");
});
