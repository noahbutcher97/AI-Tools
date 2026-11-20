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
import { discoverTargets, sendMessage } from "../../MCP-Servers/bridges/relay/client.mjs";
import { initializeCompletionJobs, openCompletionJobs, threadStatusBinding } from "../../MCP-Servers/bridges/relay/completion-jobs.mjs";
import { listenForJobReports } from "../../MCP-Servers/bridges/relay/completion-broker.mjs";
import { startRun } from "../../MCP-Servers/bridges/relay/run-job.mjs";
import { localStatus, sendProvedNotice } from "../../MCP-Servers/bridges/relay/local-ping.mjs";
import { runProvider } from "../../MCP-Servers/bridges/relay/provider-process.mjs";
import { subscribeWatch } from "../../MCP-Servers/bridges/relay/watch-client.mjs";
import { scheduleNotice } from "../../MCP-Servers/bridges/relay/completion-protocol.mjs";
import { branchBinding } from "../../MCP-Servers/bridges/relay/schedule-watch.mjs";
import { readWatcher } from "../../MCP-Servers/bridges/relay/watcher-health.mjs";
import { trialInputCount } from "./trial-input-count.mjs";

// Opt-in live check. The installed provider uses its signed-in desktop profile.
// Only the disposable thread created below receives a turn or is archived.
const image = process.argv[2];
if (typeof image !== "string" || !path.isAbsolute(image) || !fs.statSync(image).isFile()) throw Error("Supply an installed provider executable");
const fromShell = process.argv[3] === "--from-shell";
const turnStudy = process.argv[3] === "--turn-metadata";
const schedule = turnStudy || process.argv[3] === "--schedule";
const checkMcp = process.argv[3] === "--mcp-watch";
const installedBranch = ["--installed-branch","--installed-mcp-branch"].includes(process.argv[3]);
const installedMcp = ["--installed-mcp-schedule","--installed-mcp-file","--installed-mcp-branch"].includes(process.argv[3]);
const installedWatch = installedMcp || ["--installed-schedule","--installed-branch"].includes(process.argv[3]);
const installed = installedWatch || process.argv[3] === "--installed";
const exchangeDir = installed ? process.argv[4] : null;
const preparedTrial = installedMcp || installedBranch ? process.argv[5] : undefined;
if (installedBranch && !preparedTrial) throw Error("Supply the branch trial condition ID");
if (preparedTrial !== undefined && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(preparedTrial)) throw Error("Invalid trial ID");
if (process.argv.length !== (installed ? (preparedTrial ? 6 : 5) : fromShell || schedule || checkMcp ? 4 : 3)) throw Error("Unexpected qualification argument");
if (installed && (!path.isAbsolute(exchangeDir) || path.relative(exchangeDir, fs.realpathSync.native(exchangeDir)) !== "" ||
    fs.readdirSync(exchangeDir).length)) throw Error("Supply an empty private trial directory");
const signals = preparedTrial ? path.join(process.env.ProgramFiles, "RelayWatcherTrial-" + preparedTrial.replaceAll("-", "")) :
  installed ? path.dirname(exchangeDir) : undefined;
const resumedDirectory = installed ? path.join(signals, "session") : undefined;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resume-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const model = "gpt-6-luna";
const mcpWorkspace = fileURLToPath(new URL("../../", import.meta.url));
const params = { model, cwd: checkMcp || installedMcp ? mcpWorkspace : workspace, sandbox: fromShell ? "workspace-write" : "read-only", approvalPolicy: "never",
  config: { model_reasoning_effort: "low" } };
const sessionName = "relay-check-" + (installedBranch ? preparedTrial : randomUUID());
let provider, store, listener, id;
let stopSampling;
const indexedBusy = new Set();
const startedSignals = new Map();
const providers = [];
const ownedOutputs = new Set();
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
  const args = ["app-server"];
  const env = { ...process.env };
  if (checkMcp || installedMcp) {
    args.push("-c", 'mcp_servers.relay.tools.relay_watch.approval_mode="approve"');
    args.push("-c", 'mcp_servers.relay.enabled_tools=["relay_watch"]');
    for (const name of ["CODEX_THREAD_ID","CODEX_SESSION_ID","CLAUDE_CODE_SESSION_ID"]) delete env[name];
  }
  const child = spawn(image, args, { cwd: checkMcp || installedMcp ? mcpWorkspace : root, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = once(child, "close");
  const inbox = new Map(), turns = new Map(), shellResults = [];
  const diagnostics = new Map();
  const watchCalls = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const msg = JSON.parse(line);
    if (msg.id && inbox.has(msg.id)) inbox.get(msg.id)(msg);
    if (msg.method === "turn/completed" && (!turnStudy || msg.params.threadId === id)) {
      turns.set(msg.params.turn.id, msg.params.turn.status);
    }
    if (turnStudy) {
      if (msg.method === "turn/started" && msg.params.threadId === id) {
        const turn = msg.params.turn;
        startedSignals.set(turn.id, { status: turn.status, fields: Object.keys(turn).sort() });
      }
      return;
    }
    if (msg.method === "item/completed") {
      const { turnId, item } = msg.params;
      const evidence = diagnostics.get(turnId) ?? { items: [], refusalReported: false, shellUnavailableReported: false };
      evidence.items.push(item.type);
      if (item.type === "mcpToolCall" && item.server === "relay" && item.tool === "relay_watch") {
        const text = item.result?.content?.find(c => c.type === "text")?.text;
        let result;
        try { result = JSON.parse(text); } catch { /* No structured relay result. */ }
        watchCalls.push({ turnId, to: item.arguments?.target, condition: item.arguments?.condition, result });
      }
      if (item.type === "agentMessage") {
        if (checkMcp || installedMcp) {
          evidence.toolAbsent ||= /unavailable|do not have|don't have|not (?:available|exposed|listed)|no (?:relay|tool)|cannot access/i.test(item.text);
          evidence.approval ||= /approval|permission/i.test(item.text);
        }
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
  const p = { call, turns, shellResults, diagnostics, watchCalls, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    try { await closed; } finally { clearTimeout(timer); lines.close(); }
  } };
  providers.push(p);
  await call("initialize", { clientInfo: { name: "relay_qualification", version: "1" }, capabilities: { experimentalApi: true } });
  return p;
}
async function callWatch(condition, expected) {
  const effective = await provider.call("config/read", { cwd: mcpWorkspace, includeLayers: false });
  assert.equal(effective.config?.mcp_servers?.relay?.tools?.relay_watch?.approval_mode, "approve",
    "The qualification server did not load the scoped tool approval");
  const inventory = await provider.call("mcpServerStatus/list", { threadId: id, limit: 100 });
  const relay = inventory.data?.find(server => server.name === "relay");
  assert.ok(relay?.tools && Object.values(relay.tools).some(tool => tool.name === "relay_watch"),
    "The thread's MCP inventory does not include relay_watch");
  const argumentsJson = JSON.stringify({ target: id, condition });
  const prompt = "This is a disposable relay qualification. Invoke the registered MCP tool mcp__relay__relay_watch exactly once. " +
    "Use functions.exec if the provider exposes tools through code mode: text(await tools.mcp__relay__relay_watch(" +
    argumentsJson + ")). For a directly exposed tool, use the same arguments. Do not use the shell. " +
    "If the tool is missing, reply TOOL_UNAVAILABLE. Otherwise finish after the tool returns.";
  const turn = await provider.call("turn/start", { threadId: id, input: [
    { type: "mention", name: "relay", path: "mcp://relay" }, { type: "text", text: prompt, text_elements: [] },
  ] });
  assert.equal(await until(() => provider.turns.get(turn.turn.id), 90000, "MCP turn did not finish"), "completed");
  const calls = provider.watchCalls.filter(c => c.turnId === turn.turn.id);
  assert.equal(calls.length, 1, "Expected one relay_watch tool event. Observed item types: " +
    JSON.stringify(provider.diagnostics.get(turn.turn.id)));
  const call = calls[0];
  assert.equal(call.to, id);
  assert.equal(call.condition, condition);
  assert.deepEqual(call.result, expected === "subscribed" ? { ok: true, state: expected, condition, target: id } :
    { ok: false, state: expected });
  return turn.turn.id;
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
  if (turnStudy) {
    const { sampleTurnStatus } = await import("./fixtures/ReadTurnMetadata.mjs");
    const timer = setInterval(() => {
      try {
        for (const row of sampleTurnStatus(id)) {
          if (row.status === "inProgress") indexedBusy.add(row.turn_id);
        }
      } catch { /* An unavailable sample supplies no evidence of activity. */ }
    }, 250);
    stopSampling = () => clearInterval(timer);
  }
  if (checkMcp || installedMcp) assert.equal(started.approvalPolicy, "never");
  if (checkMcp) {
    await callWatch(randomUUID(), "unconfirmed");
    console.log("The installed MCP tool received the calling thread identity and declined an unissued condition.");
    return;
  }
  const seed = await provider.call("turn/start", { threadId: id, input: [{ type: "text", text: "Reply only OK.", text_elements: []}] });
  const end = await until(() => provider.turns.get(seed.turn.id), 90000, "Seed turn did not finish");
  assert.equal(end, "completed");
  const targets = async () => (await discoverTargets({ scope: "all" })).targets.filter(t => t.id === id);
  const original = await until(async () => (await targets()).find(t => t.addressable), 8000, "Original thread unavailable");
  if (schedule) {
    const file = path.join(root, "jobs.sqlite");
    await initializeCompletionJobs(file);
    fs.mkdirSync(path.join(root, "completion-grants"));
    const grant = { provider: "codex", scope: "thread-schedule", condition: randomUUID(), target: id, intervalSeconds: turnStudy ? 86400 : 60,
      startsAt: new Date(Date.now() + 8000).toISOString(), expiresAt: new Date(Date.now() + 180000).toISOString() };
    let submissions = 0, proofs = 0;
    let queueId;
    const open = () => openCompletionJobs(file, { schedules: { root, policy: () => [grant] },
      send: (to, text, options) => {
        assert.ok(to === id && text === scheduleNotice, "Unexpected schedule delivery");
        const observeSend = async request => {
          const result = await sendMessage(request);
          queueId = result.queuedId;
          return result;
        };
        return sendProvedNotice(to, text, { ...options, send: turnStudy ? observeSend : sendMessage, runQueue: (dest, envelope) => {
          assert.ok(dest === id, "Unexpected schedule destination"); submissions++;
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
    assert.ok(resumed.thread.id === id, "Resumed a different thread"); assert.equal(resumed.model, model);
    await until(async () => {
      await store.watches.dispatchDue();
      return proofs === 1;
    }, 55000, "No consumed schedule notice after resume");
    assert.equal(submissions, 1);
    assert.equal(store.watches.subscriptions([grant])[0].state, "waiting");
    if (turnStudy) {
      // Completion of delivery can precede completion of the recipient's turn.
      const turnId = await until(() => [...provider.turns].find(([turn, status]) =>
        turn !== seed.turn.id && status === "completed")?.[0], 90000, "Recipient turn did not finish");
      const { confirmReadback, readTrialMetadata, summarizeTrial } = await import("./fixtures/ReadTurnMetadata.mjs");
      const live = await until(() => {
        const sample = readTrialMetadata(id, grant.condition, file);
        return sample.turns.length === 2 && sample.turns.every(t => t.status === "completed") && sample;
      }, 10000, "Completed turns unavailable in provider metadata");
      store.close(); store = null;
      const reader = fileURLToPath(new URL("./fixtures/ReadTurnMetadata.mjs", import.meta.url));
      const cold = spawnSync(process.execPath, [reader, id, grant.condition, file], {
        encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 32768
      });
      assert.equal(cold.status, 0, "Fresh observer could not read the trial metadata");
      confirmReadback(live, JSON.parse(cold.stdout));
      const report = summarizeTrial(live, seed.turn.id, turnId, queueId);
      for (const [kind, turn] of [["ordinary", seed.turn.id], ["watcher", turnId]]) {
        report[kind].sampledInProgress = indexedBusy.has(turn);
        report[kind].startSignal = startedSignals.get(turn) ?? null;
      }
      console.log(JSON.stringify({ ...report, coldReadMatched: true }));
    }
    console.log("Resumed disposable thread consumed exactly one scheduled notice after store restart.");
    return;
  }
  if (installed) {
    // The administrator authorizes the exact returned thread and independently
    // checks the installed broker's proof before allowing the writer to close.
    const write = (name, value) => {
      const dir = name === "resumed.json" ? resumedDirectory : exchangeDir;
      const temp = path.join(dir, name + ".tmp");
      const published = path.join(dir, name);
      fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      ownedOutputs.add(temp);
      fs.linkSync(temp, published);
      ownedOutputs.add(published);
      fs.unlinkSync(temp);
      ownedOutputs.delete(temp);
    };
    write("target.json", { id, model });
    const installRoot = installedBranch ? path.join(process.env.ProgramFiles, "CrossAgentRelay") : undefined;
    await until(() => {
      if (installedBranch) {
        const binding = branchBinding(id, preparedTrial);
        return readWatcher(installRoot).state === "watching" &&
          fs.existsSync(path.join(installRoot, "completion-grants", binding + ".json"));
      }
      if (fs.existsSync(path.join(signals, "finished"))) throw Error("Installed trial closed before authorization");
      return fs.existsSync(path.join(signals, "authorized"));
    }, 300000, "Trial grant was not ready");
    const cli = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/cli.mjs", import.meta.url));
    const env = { ...process.env, CODEX_THREAD_ID: id };
    delete env.CODEX_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const command = installedWatch ? ["watch", "--notify", id, installedBranch ? preparedTrial : fs.readFileSync(path.join(signals, "authorized"), "utf8")] :
      ["run", "--", process.execPath, "-e", "process.exit(23)"];
    let job, activation;
    if (installedMcp) {
      activation = await callWatch(command.at(-1), "subscribed");
    } else {
      const result = spawnSync(process.execPath, [cli, ...command], {
        cwd: workspace, env, input: "", encoding: "utf8", timeout: 15000, windowsHide: true,
      });
      assert.equal(result.status, 0, "The installed broker did not confirm the public CLI request");
      job = JSON.parse(result.stdout);
    }
    if (installedWatch) {
      if (!installedMcp) assert.equal(job.state, "subscribed");
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
    if (installedBranch) {
      await until(() => readWatcher(installRoot).state === "reports_only", 360000, "Branch trial cleanup timed out");
      // Let the resumed writer drain after the broker loses delivery authority.
      // Only the protected verifier can establish what the one input contained.
      await delay(5000);
      const count = await trialInputCount(id, seed.turn.id, activation);
      if (count !== "one") process.exitCode = { none: 20, extra: 21, unknown: 22 }[count];
      return;
    }
    await until(() => fs.existsSync(path.join(signals, "finished")), installedMcp ? 240000 : 150000, "Installed delivery was not confirmed");
    const resultText = fs.readFileSync(path.join(signals, "result.txt"), "utf8");
    if (resultText !== "proved") {
      // Emit only the controlled failure category from the administrator's
      // receipt. Local paths and arbitrary child output stay out of reports.
      const gate = ["Disposable writer did not resume","The first scheduled tick must follow activation",
        "Watcher startup is unproven","Unexpected watcher mode","Transcript proof timed out","Status lookup failed"]
        .find(label => resultText.includes(label));
      throw Error("The installed trial failed: " + (gate ?? "unclassified gate"));
    }
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
  stopSampling?.();
  let archived = false;
  if (id && provider) {
    try {
      await provider.call("thread/archive", { threadId: id });
      archived = true;
      if (turnStudy) console.log("Disposable qualification thread archived.");
    } catch { console.error("The disposable thread could not be archived."); process.exitCode = 1; }
  }
  for (const p of providers) await p.close();
  if (!installedBranch || archived) {
    for (const file of ownedOutputs) fs.rmSync(file, { force: true });
  }
  await listener?.close();
  store?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
