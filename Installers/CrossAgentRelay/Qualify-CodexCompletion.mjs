import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { discoverTargets } from "../../MCP-Servers/bridges/relay/client.mjs";
import { initializeCompletionJobs, openCompletionJobs, threadStatusBinding } from "../../MCP-Servers/bridges/relay/completion-jobs.mjs";
import { listenForJobReports } from "../../MCP-Servers/bridges/relay/completion-broker.mjs";
import { startRun } from "../../MCP-Servers/bridges/relay/run-job.mjs";
import { localStatus, sendProvedNotice } from "../../MCP-Servers/bridges/relay/local-ping.mjs";
import { runProvider } from "../../MCP-Servers/bridges/relay/provider-process.mjs";
import { subscribeWatch } from "../../MCP-Servers/bridges/relay/watch-client.mjs";
import { scheduleNotice } from "../../MCP-Servers/bridges/relay/completion-protocol.mjs";

// Opt-in live check. The installed provider uses its signed-in desktop profile.
// Only the disposable thread created below receives a turn or is archived.
const image = process.argv[2];
if (typeof image !== "string" || !path.isAbsolute(image) || !fs.statSync(image).isFile()) throw Error("Supply an installed provider executable");
const fromShell = process.argv[3] === "--from-shell";
const schedule = process.argv[3] === "--schedule";
const installedSchedule = process.argv[3] === "--installed-schedule";
const installed = installedSchedule || process.argv[3] === "--installed";
const exchangeDir = installed ? process.argv[4] : null;
if (process.argv.length !== (installed ? 5 : fromShell || schedule ? 4 : 3)) throw Error("Unexpected qualification argument");
if (installed && (!path.isAbsolute(exchangeDir) || path.relative(exchangeDir, fs.realpathSync.native(exchangeDir)) !== "" ||
    fs.readdirSync(exchangeDir).length)) throw Error("Supply an empty private trial directory");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const model = "gpt-6-luna";
const params = { model, cwd: workspace, sandbox: fromShell ? "workspace-write" : "read-only", approvalPolicy: "never",
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
  const inbox = new Map(), turns = new Map(), shellResults = [];
  const diagnostics = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const msg = JSON.parse(line);
    if (msg.id && inbox.has(msg.id)) inbox.get(msg.id)(msg);
    if (msg.method === "turn/completed") turns.set(msg.params.turn.id, msg.params.turn.status);
    if (msg.method === "item/completed") {
      const { turnId, item } = msg.params;
      const evidence = diagnostics.get(turnId) ?? { items: [], refusalReported: false, shellUnavailableReported: false };
      evidence.items.push(item.type);
      if (item.type === "agentMessage") {
        evidence.refusalReported ||= /EXECUTION_REFUSED|refused|rejected|denied|blocked by policy/i.test(item.text);
        evidence.shellUnavailableReported ||= /SHELL_UNAVAILABLE/i.test(item.text);
      }
      diagnostics.set(turnId, evidence);
    }
    if (msg.method === "item/completed" && msg.params.item.type === "commandExecution") {
      const item = msg.params.item;
      const output = item.aggregatedOutput ?? "";
      shellResults.push({
        exitCode: item.exitCode, started: /"state"\s*:\s*"started"/.test(output),
        denied: /access is denied|blocked by policy|permission denied|rejected/i.test(output),
        noSession: output.includes("Run is unavailable in this session"),
      });
    }
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
  const p = { call, turns, shellResults, diagnostics, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    try { await closed; } finally { clearTimeout(timer); lines.close(); }
  } };
  providers.push(p);
  await call("initialize", { clientInfo: { name: "relay_qualification", version: "1" }, capabilities: { experimentalApi: true } });
  return p;
}
async function runTrial() {
  provider = await startProvider();
  const started = await provider.call("thread/start", { ...params, threadSource: "user" });
  id = started.thread.id;
  assert.equal(started.model, model);
  if (fromShell) {
    assert.equal(started.sandbox.type, "workspaceWrite");
    console.log("Workspace shell network access: " + started.sandbox.networkAccess);
    assert.equal(started.approvalPolicy, "never");
  }
  await provider.call("thread/name/set", { threadId: id, name: sessionName });
  const seed = await provider.call("turn/start", { threadId: id, input: [{ type: "text", text: "Reply only OK.", text_elements: []}] });
  const end = await until(() => provider.turns.get(seed.turn.id), 90000, "Seed turn did not finish");
  assert.equal(end, "completed");
  const targets = async () => (await discoverTargets({ scope: "all" })).targets.filter(t => t.id === id);
  const original = await until(async () => (await targets()).find(t => t.addressable), 8000, "Original thread unavailable");
  if (schedule) {
    const file = path.join(root, "jobs.sqlite");
    await initializeCompletionJobs(file);
    fs.mkdirSync(path.join(root, "completion-grants"));
    const grant = { provider: "codex", scope: "thread-schedule", condition: randomUUID(), target: id, intervalSeconds: 60,
      startsAt: new Date(Date.now() + 8000).toISOString(), expiresAt: new Date(Date.now() + 180000).toISOString() };
    let submissions = 0, proofs = 0;
    const open = () => openCompletionJobs(file, { schedules: { root, policy: () => [grant] },
      send: (to, text, options) => {
        assert.equal(to, id); assert.equal(text, scheduleNotice);
        return sendProvedNotice(to, text, { ...options, runQueue: (dest, envelope) => {
          assert.equal(dest, id); submissions++;
          return runProvider(image, ["queue", "--thread", dest, "--message", envelope], { cwd: root });
        } });
      },
      status: async handle => {
        const result = await localStatus(handle);
        if (result.state === "delivered" && result.to === id) proofs++;
        return result;
      },
    });
    store = await open();
    store.watches.provision();
    listener = await listenForJobReports(store.acceptFrame, { port: 0 });
    const activated = await subscribeWatch(id, grant.condition, { id, provider: "codex" }, { root, port: listener.port });
    assert.equal(activated.ok, true);
    assert.equal(await store.watches.dispatchDue(), false);
    await provider.close();
    await until(async () => (await targets()).length === 0, 8000, "Original writer did not close");
    await until(() => Date.now() >= Date.parse(grant.startsAt), 10000, "UTC tick did not arrive");
    assert.equal(await store.watches.dispatchDue(), true);
    assert.equal(submissions, 0);
    await listener.close(); listener = null;
    store.close(); store = await open();
    provider = await startProvider();
    const resumed = await provider.call("thread/resume", { ...params, threadId: id, excludeTurns: true });
    assert.equal(resumed.thread.id, id); assert.equal(resumed.model, model);
    await until(async () => {
      await store.watches.dispatchDue();
      return proofs === 1;
    }, 55000, "No consumed schedule notice after resume");
    assert.equal(submissions, 1);
    assert.equal(store.watches.subscriptions([grant])[0].state, "waiting");
    console.log("Resumed disposable thread consumed exactly one scheduled notice after store restart.");
    return;
  }
  if (installed) {
    // The administrator authorizes the exact returned thread and independently
    // checks the installed broker's proof before allowing the writer to close.
    const write = (name, value) => {
      const temp = path.join(exchangeDir, name + ".tmp");
      fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, path.join(exchangeDir, name));
    };
    write("target.json", { id, model });
    const signals = path.dirname(exchangeDir);
    await until(() => {
      if (fs.existsSync(path.join(signals, "finished"))) throw Error("Installed trial closed before authorization");
      return fs.existsSync(path.join(signals, "authorized"));
    }, 300000, "Trial grant was not ready");
    const cli = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/cli.mjs", import.meta.url));
    const env = { ...process.env, CODEX_THREAD_ID: id };
    delete env.CODEX_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const command = installedSchedule ? ["watch", "--notify", id, fs.readFileSync(path.join(signals, "authorized"), "utf8")] :
      ["run", "--", process.execPath, "-e", "process.exit(23)"];
    const result = spawnSync(process.execPath, [cli, ...command], {
      cwd: workspace, env, input: "", encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    assert.equal(result.status, 0, "The installed broker did not confirm the public CLI request");
    const job = JSON.parse(result.stdout);
    if (installedSchedule) {
      assert.equal(job.state, "subscribed");
      await provider.close();
      await until(async () => (await targets()).length === 0, 8000, "Original writer did not close");
      provider = await startProvider();
      const resumed = await provider.call("thread/resume", { ...params, threadId: id, excludeTurns: true });
      assert.equal(resumed.thread.id, id);
      assert.equal(resumed.model, model);
      await until(async () => (await targets()).some(t => t.addressable), 8000, "Resumed writer unavailable");
      write("resumed.json", { id });
    } else {
      assert.equal(job.state, "started");
      write("job.json", { id: job.id });
    }
    await until(() => fs.existsSync(path.join(signals, "finished")), 150000, "Installed delivery was not confirmed");
    return;
  }
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
  listener = await listenForJobReports(store.acceptFrame, fromShell ? {} : { port: 0 });
  const release = path.join(workspace, "release");
  const childScript = `
    const fs = require("node:fs");
    const deadline = Date.now() + 90000;
    setInterval(() => {
      if (fs.existsSync(process.argv.at(-1))) process.exit(23);
      if (Date.now() > deadline) process.exit(1);
    }, 50);`;
  if (fromShell) {
    const cli = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/cli.mjs", import.meta.url));
    const grantFile = path.join(root, "grant.json");
    const jobFile = path.join(workspace, "job.cjs");
    fs.writeFileSync(grantFile, JSON.stringify(grant), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(jobFile, childScript);
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const command = "Get-Content -LiteralPath " + quote(grantFile) + " -Raw | & " +
      [process.execPath, cli, "run", "--", process.execPath, jobFile, release].map(quote).join(" ");
    const prompt = "Run this qualification command exactly once through the ordinary PowerShell tool. " +
      "Pipe the private input as shown. Do not display its contents. If execution is refused, report EXECUTION_REFUSED and stop. " +
      "If this session has no shell tool, report SHELL_UNAVAILABLE and stop.\n" + command;
    const turn = await provider.call("turn/start", { threadId: id, input: [{ type: "text", text: prompt, text_elements: [] }] });
    await until(() => provider.turns.has(turn.turn.id), 90000, "Shell turn did not finish");
    fs.unlinkSync(grantFile);
    const state = store.subscriptions().subscriptions.find(s => s.id === grant.id)?.state;
    if (provider.shellResults.length !== 1 || !provider.shellResults[0].started || state !== "claimed") {
      throw Error("Shell launch unproven: " + JSON.stringify({ state, commands: provider.shellResults,
        turn: provider.turns.get(turn.turn.id), evidence: provider.diagnostics.get(turn.turn.id) }));
    }
  } else {
    const result = await startRun([process.execPath, "-e", childScript, release], { provider: "codex", id },
      Readable.from([JSON.stringify(grant)]), { port: listener.port });
    assert.equal(result.state, "started");
  }
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
}

try {
  await runTrial();
} finally {
  if (id && provider) {
    try { await provider.call("thread/archive", { threadId: id }); } catch { console.error("The disposable thread could not be archived."); process.exitCode = 1; }
  }
  for (const p of providers) await p.close();
  if (installed) {
    for (const name of ["target.json", "target.json.tmp", "job.json", "job.json.tmp", "resumed.json", "resumed.json.tmp"]) {
      fs.rmSync(path.join(exchangeDir, name), { force: true });
    }
  }
  await listener?.close();
  store?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
