import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { newRequestId } from "./delivery-protocol.mjs";
import { initializeReceipts } from "./receipts.mjs";
import { initializeCompletionJobs, openCompletionJobs } from "./completion-jobs.mjs";
import { listenForJobReports } from "./completion-broker.mjs";

const bridge = fileURLToPath(new URL(".", import.meta.url));
const loader = new URL("../../../Installers/CrossAgentRelay/fixtures/local-inventory-loader.mjs", import.meta.url);
const nodeArgs = ["--no-warnings", "--experimental-loader", loader.href];
const shared = "--Sample:Chat/One";
const unique = "Sample:Only/Two";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-effect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  const records = file => fs.existsSync(path.join(root, file)) ?
    fs.readFileSync(path.join(root, file), "utf8").trimEnd().split("\n").map(JSON.parse) : [];
  fs.mkdirSync(path.join(root, "peer"));
  write("machine.json", { host: "host-a" });
  write("hosts.json", ["host-a", "host-b", "old-peer"].map(host => ({ host, endpoint: host, port: 22, user: "operator" })));
  write("peer/machine.json", { host: "host-b" });
  write("peer/inventory-adapters.json", { enabled: ["sample", "other"] });
  write("peer/receive-policy.json", { enabled: true, codex: [] });
  write("peer/lookup-policy.json", { v: 1, grants: [{ peer: "host-a", ids: [shared, unique] }] });
  const grants = ["sample", "other"].map(adapter => ({ peer: "host-a", adapter, ids: [shared, unique], ops: ["send", "ping", "status"] }));
  write("peer/effect-policy.json", { v: 1, grants });
  const configure = (options = {}) => write("fixture-effects.json", { sample: [shared, unique], other: [shared], ...options });
  configure();
  await initializeReceipts(path.join(root, "peer", "receipts.sqlite"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, RELAY_FIXTURE_ROOT: root };
  for (const key of Object.keys(env)) {
    if (["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID"].includes(key.toUpperCase())) delete env[key];
  }
  const cli = (...args) => {
    if (args[0] !== "watch") args.push("--json");
    const run = spawnSync(process.execPath, [...nodeArgs, "cli.mjs", ...args], { cwd: bridge, env, encoding: "utf8", timeout: 15000 });
    assert.ok([0, 1].includes(run.status), run.error?.message ?? run.stderr);
    return JSON.parse(run.stdout);
  };
  const mcp = async (name, args, metadata) => {
    const client = new Client({ name: "effect-check", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...nodeArgs, "server.mjs"], cwd: bridge, env, stderr: "pipe" }));
    try {
      const response = await client.callTool({ name, arguments: args, _meta: metadata });
      return JSON.parse(response.content[0].text);
    } finally { await client.close(); }
  };
  return { cli, mcp, configure, write, grants, root, env, frames: () => records("lookup-frames.jsonl"), submitted: () => records("peer/submitted.jsonl") };
}

test("remote CLI and MCP keep selection, retries and cold status bound to the same reader", async t => {
  try { await import("node:sqlite"); } catch { return t.skip("node:sqlite unavailable"); }
  const f = await fixture(t);
  const host = "host-b", message = "Synthetic notice", requestId = newRequestId();
  const raw = { host, id: shared };
  const target = { ...raw, adapter: "sample" };
  const options = { ...target, message, request_id: requestId };
  const cliSend = (...args) => f.cli("send", "--host", host, "--id=" + shared, "--message", message, ...args);
  assert.equal(cliSend().state, "ambiguous");
  assert.deepEqual((await f.mcp("relay_send", { ...raw, message })).adapters.sort(), ["other", "sample"]);
  assert.deepEqual(f.frames().map(row => row.op), ["lookup", "lookup"]);

  assert.equal((await f.mcp("relay_send", { host, id: unique, message, dry_run: true })).state, "eligible");
  assert.deepEqual(f.frames().slice(-2).map(row => row.op), ["lookup", "resolve"]);
  assert.equal(cliSend("--adapter", "sample", "--dry-run").state, "eligible");
  assert.equal(f.submitted().length, 0);
  assert.ok(f.frames().every(row => !Object.hasOwn(row, "message")));

  const result = cliSend("--adapter", "sample", "--request-id", requestId);
  assert.equal(result.state, "queued", JSON.stringify(result));
  assert.deepEqual(result.target, target);
  const sent = f.submitted();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].binding, target);
  assert.ok(sent[0].text.includes(message));
  assert.deepEqual(f.frames().slice(-2).map(row => [row.v, row.op, row.adapter]), [[4, "resolve", "sample"], [4, "send", "sample"]]);
  assert.equal((await f.mcp("relay_send", options)).handle, result.handle);
  assert.equal((await f.mcp("relay_send", { ...options, message: "Different notice" })).cause, "request_conflict");
  assert.equal((await f.mcp("relay_send", { ...options, adapter: "other" })).cause, "request_conflict");
  assert.equal(f.frames().at(-1).op, "resolve");
  assert.equal(f.submitted().length, 1);

  f.configure({ sample: [], other: [] });
  assert.equal((await f.mcp("relay_send", options)).state, "queued");
  assert.equal((await f.mcp("relay_ping", { status: result.handle })).state, "queued");
  assert.equal(f.cli("ping", "--status", result.handle).delivery, "not_proven");
  assert.equal(f.frames().at(-1).op, "status");
  assert.equal(f.submitted().length, 1);
  f.write("peer/effect-policy.json", { v: 1, grants: f.grants.map(row => ({ ...row, ops: ["send", "ping"] })) });
  assert.equal(f.cli("ping", "--status", result.handle).state, "receive_denied");
  assert.equal(f.submitted().length, 1);
});

test("body-free refusals and interrupted remote probes recover through a fresh public caller", async t => {
  try { await import("node:sqlite"); } catch { return t.skip("node:sqlite unavailable"); }
  const f = await fixture(t);
  const target = { host: "host-b", id: shared, adapter: "other" };
  const oldSelector = { ...target, host: "old-peer" };
  const message = "Synthetic notice";
  assert.equal((await f.mcp("relay_send", { ...oldSelector, message })).cause, "effect_refused");
  assert.equal(f.cli("ping", "--id=" + shared, "--adapter", "other", "--host", "old-peer").cause, "effect_refused");
  f.configure({ wrongReply: true });
  assert.equal((await f.mcp("relay_send", { ...target, message })).cause, "invalid_response");
  assert.ok(f.frames().every(row => row.op === "resolve" && !Object.hasOwn(row, "message")));
  assert.equal(f.submitted().length, 0);

  f.configure({ substituteState: { op: "resolve", state: "queued" } });
  assert.equal((await f.mcp("relay_send", { ...target, message })).cause, "invalid_response");
  assert.equal(f.submitted().length, 0);
  f.configure({ substituteState: { op: "send", state: "eligible" } });
  const uncertainSend = await f.mcp("relay_send", { ...target, message });
  assert.equal(uncertainSend.cause, "unknown");
  assert.equal(f.cli("ping", "--status", uncertainSend.handle).state, "queued");
  assert.equal(f.submitted().length, 1);

  f.configure({ dropReply: "ping" });
  const requestId = newRequestId();
  const attempt = await f.mcp("relay_ping", { ...target, request_id: requestId });
  assert.equal(attempt.cause, "unknown", JSON.stringify(attempt));
  assert.ok(attempt.detail.includes("ping --status " + attempt.handle));
  assert.equal(f.submitted().length, 2);
  f.configure({ sample: [], other: [] });
  assert.equal(f.cli("ping", "--status", attempt.handle).state, "pending");
  const notice = f.submitted()[1];
  const unrelated = [
    { ...notice, binding: { ...notice.binding, adapter: "sample" } },
    { ...notice, binding: { ...notice.binding, id: unique } },
    { ...notice, binding: { ...notice.binding, host: "host-a" } },
    { ...notice, text: "Unrelated inbound notice." },
  ];
  f.write("peer/inbound.json", unrelated);
  assert.equal((await f.mcp("relay_ping", { status: attempt.handle })).state, "pending");
  f.write("peer/inbound.json", [...unrelated, notice]);
  assert.equal(f.cli("ping", "--status", attempt.handle).state, "delivered");
  assert.equal(f.cli("ping", "--id=" + shared, "--adapter", "other", "--host", "host-b", "--request-id", requestId).state, "delivered");
  assert.equal(f.submitted().length, 2);
  const [prefix, encoded] = attempt.handle.split(".");
  const fields = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  fields[1] = "sample";
  const wrong = prefix + "." + Buffer.from(JSON.stringify(fields)).toString("base64url");
  assert.equal((await f.mcp("relay_ping", { status: wrong })).state, "missing");
  const count = f.frames().length;
  assert.equal(f.cli("ping", "--status", attempt.handle + "=").cause, "invalid_handle");
  assert.equal(f.frames().length, count);
  assert.equal(f.submitted().length, 2);
});

test("a send-only client can ring a synthetic recipient but cannot activate a Codex thread's granted watch", async t => {
  try { await import("node:sqlite"); } catch { return t.skip("node:sqlite unavailable"); }
  const f = await fixture(t);
  const target = randomUUID(), condition = randomUUID(), start = Date.now();
  const policy = [{ target, condition, provider: "codex", scope: "thread-schedule",
    startsAt: new Date(start).toISOString(), expiresAt: new Date(start + 3600000).toISOString(), intervalSeconds: 60 }];
  fs.mkdirSync(path.join(f.root, "completion-grants"));
  const file = path.join(f.root, "jobs.sqlite");
  await initializeCompletionJobs(file);
  const store = await openCompletionJobs(file, { schedules: { root: f.root, policy: () => policy } });
  let listener;
  try {
    store.watches.provision();
    const activations = [];
    listener = await listenForJobReports(frame => { activations.push(frame.op); return store.acceptFrame(frame); }, { port: 0 });
    f.env.RELAY_FIXTURE_BROKER_PORT = String(listener.port);
    const unqualifiedWriter = writer => ({ "example/turn": { thread_id: target, writer } });
    const request = { host: "host-b", adapter: "sample", id: unique, message: "Example notice." };
    assert.equal((await f.mcp("relay_send", request, unqualifiedWriter("first"))).state, "queued");
    const [notice] = f.submitted();
    const header = JSON.parse(notice.text.split("\n", 1)[0].slice("RELAY-META ".length));
    assert.equal(header.from.session_evidence, "absent");
    assert.deepEqual(notice.binding, { host: request.host, adapter: request.adapter, id: request.id });

    const watch = { target, condition };
    const refusal = f.cli("watch", "--notify", target, condition);
    assert.equal(refusal.state, "denied");
    assert.match(refusal.detail, /intended Codex thread/);
    for (const writer of ["first", "resumed"]) {
      assert.deepEqual(await f.mcp("relay_watch", watch, unqualifiedWriter(writer)), refusal);
    }
    const qualified = { "x-codex-turn-metadata": { thread_id: target } };
    assert.deepEqual(await f.mcp("relay_watch", watch, { threadId: target }), refusal);
    assert.deepEqual(await f.mcp("relay_watch", watch, { ...qualified, threadId: randomUUID() }), refusal);
    f.env.CLAUDE_CODE_SESSION_ID = target;
    assert.deepEqual(await f.mcp("relay_watch", watch, qualified), refusal);
    f.env.CODEX_THREAD_ID = target;
    assert.deepEqual(f.cli("watch", "--notify", target, condition), refusal);
    delete f.env.CLAUDE_CODE_SESSION_ID;
    assert.deepEqual(await f.mcp("relay_watch", watch, { threadId: target }), refusal);
    f.env.CODEX_SESSION_ID = randomUUID();
    assert.deepEqual(f.cli("watch", "--notify", target, condition), refusal);
    delete f.env.CODEX_SESSION_ID;
    assert.deepEqual(activations, []);
    assert.deepEqual(store.watches.subscriptions(policy), []);
    assert.equal(f.submitted().length, 1);

    // Both qualified entry points reach the same broker and idempotent grant.
    const cli = await promisify(execFile)(process.execPath, [...nodeArgs, "cli.mjs", "watch", "--notify", target, condition],
      { cwd: bridge, env: f.env, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(JSON.parse(cli.stdout).state, "subscribed");
    delete f.env.CODEX_THREAD_ID;
    assert.equal((await f.mcp("relay_watch", watch, { ...qualified, threadId: target })).state, "subscribed");
    assert.deepEqual(activations, ["activate_schedule", "activate_schedule"]);
    assert.deepEqual(store.watches.subscriptions(policy), [{ id: condition, target, condition: "schedule", state: "waiting" }]);
    assert.equal((await f.mcp("relay_send", request, { threadId: target })).state, "queued");
    const sent = f.submitted();
    assert.equal(sent.length, 2);
    const legacy = JSON.parse(sent[1].text.split("\n", 1)[0].slice("RELAY-META ".length));
    assert.equal(legacy.from.id, target);
    assert.equal(legacy.from.session_evidence, "claimed");
  } finally { await listener?.close(); store.close(); }
});
