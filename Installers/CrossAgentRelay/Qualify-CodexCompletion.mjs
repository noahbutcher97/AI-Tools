import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { discoverTargets } from "../../MCP-Servers/bridges/relay/client.mjs";
import { initializeCompletionJobs, openCompletionJobs, threadStatusBinding } from "../../MCP-Servers/bridges/relay/completion-jobs.mjs";
import { listenForJobReports } from "../../MCP-Servers/bridges/relay/completion-broker.mjs";
import { startRun } from "../../MCP-Servers/bridges/relay/run-job.mjs";
import { localStatus, sendProvedNotice } from "../../MCP-Servers/bridges/relay/local-ping.mjs";
import { runProvider } from "../../MCP-Servers/bridges/relay/provider-process.mjs";

// Opt-in live check. The installed provider uses its signed-in desktop profile.
// Only the disposable thread created below receives a turn or is archived.
const image = process.argv[2];
if (typeof image !== "string" || !path.isAbsolute(image) || !fs.statSync(image).isFile()) throw Error("Supply an installed provider executable");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-"));
const model = "gpt-6-luna";
const params = { model, cwd: root, sandbox: "read-only", approvalPolicy: "never",
  config: { model_reasoning_effort: "low" } };
const sessionName = "relay-check-" + randomUUID();
let provider, store, listener, id;
const providers = [];
async function until(check, ms, reason) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw Error(reason);
}
async function startProvider() {
  const child = spawn(image, ["app-server"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = once(child, "close");
  const inbox = new Map(), turns = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const msg = JSON.parse(line);
    if (msg.id && inbox.has(msg.id)) inbox.get(msg.id)(msg);
    if (msg.method === "turn/completed") turns.set(msg.params.turn.id, msg.params.turn.status);
  });
  child.stdin.on("error", () => {});
  let seq = 0;
  async function call(method, params) {
    const index = ++seq;
    let result;
    inbox.set(index, frame => { result = frame; });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: index, method, params }) + "\n");
    try {
      await until(() => result || child.exitCode !== null || child.signalCode !== null, 30000, "Provider request timed out: " + method);
      if (!result || result.error) throw Error("Provider unavailable for " + method);
      return result.result;
    } finally { inbox.delete(index); }
  }
  const p = { call, turns, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    try { await closed; } finally { clearTimeout(timer); lines.close(); }
  } };
  providers.push(p);
  await call("initialize", { clientInfo: { name: "relay_qualification", version: "1" }, capabilities: { experimentalApi: true } });
  return p;
}
try {
  provider = await startProvider();
  const started = await provider.call("thread/start", { ...params, threadSource: "user" });
  id = started.thread.id;
  assert.equal(started.model, model);
  await provider.call("thread/name/set", { threadId: id, name: sessionName });
  const seed = await provider.call("turn/start", { threadId: id, input: [{ type: "text", text: "Reply only OK.", text_elements: []}] });
  const end = await until(() => provider.turns.get(seed.turn.id), 90000, "Seed turn did not finish");
  assert.equal(end, "completed");
  const targets = async () => (await discoverTargets({ scope: "all" })).targets.filter(t => t.id === id);
  const original = await until(async () => (await targets()).find(t => t.addressable), 8000, "Original thread unavailable");
  const file = path.join(root, "jobs.sqlite");
  await initializeCompletionJobs(file);
  let submissions = 0;
  store = await openCompletionJobs(file, {
    permits: (to, kind, binding) => to === id && kind === "codex" && binding === threadStatusBinding(id),
    send: (to, text, options) => sendProvedNotice(to, text, { ...options, runQueue: async (dest, envelope) => {
      assert.equal(dest, id);
      assert.match(text, /^Job [a-f0-9-]{36} ended with exit code 23\. No reply is needed\.$/);
      submissions++;
      return runProvider(image, ["queue", "--thread", dest, "--message", envelope], { cwd: root });
    }}),
    status: localStatus,
  });
  const grant = store.issue(original, Date.now() + 180000);
  listener = await listenForJobReports(store.acceptFrame, { port: 0 });
  const release = path.join(root, "release");
  const childScript = `
    const fs = require("node:fs");
    const deadline = Date.now() + 90000;
    setInterval(() => {
      if (fs.existsSync(process.argv[1])) process.exit(23);
      if (Date.now() > deadline) process.exit(1);
    }, 50);`;
  const result = await startRun([process.execPath, "-e", childScript, release], { provider: "codex", id },
    Readable.from([JSON.stringify(grant)]), { port: listener.port });
  assert.equal(result.state, "started");
  await provider.close();
  await until(async () => (await targets()).length === 0, 8000, "Original writer did not close");
  fs.writeFileSync(release, "");
  const state = () => store.subscriptions().subscriptions.find(s => s.id === grant.id)?.state;
  await until(() => state() === "ready", 8000, "Command exit unavailable");
  assert.equal(await store.dispatch(grant.id), "ready");
  assert.equal(submissions, 0);
  provider = await startProvider();
  const resumed = await provider.call("thread/resume", { ...params, threadId: id, excludeTurns: true });
  assert.equal(resumed.thread.id, id);
  assert.equal(resumed.model, model);
  await until(async () => (await targets()).find(t => t.addressable), 8000, "Resumed thread unavailable");
  await until(async () => (await store.dispatch(grant.id)) === "delivered", 45000, "No consumed status message after resume");
  assert.equal(submissions, 1);
  console.log("Original command exited offline. The resumed thread consumed one status notice.");
} finally {
  if (id && provider) {
    try { await provider.call("thread/archive", { threadId: id }); } catch { console.error("The disposable thread could not be archived."); process.exitCode = 1; }
  }
  for (const p of providers) await p.close();
  await listener?.close();
  store?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
