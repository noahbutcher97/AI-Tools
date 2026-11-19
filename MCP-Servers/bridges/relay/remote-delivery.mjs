import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexQueueBlock, resolveCodexReference } from "./client.mjs";
import { inventory, installationRoot } from "./fleet.mjs";
import { exactKeys, HOST, UUID, matches, remoteEnvelope, requestDigest } from "./delivery-protocol.mjs";
import { openReceipts } from "./receipts.mjs";

function policyAllows(peer, id) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(installationRoot(), "receive-policy.json"), "utf8"));
    return exactKeys(policy, ["enabled", "codex"]) && policy.enabled === true && Array.isArray(policy.codex) &&
      policy.codex.every(row => exactKeys(row, ["peer", "ids"]) && matches(HOST, row.peer) &&
        (row.ids === "all" || (Array.isArray(row.ids) && row.ids.every(id => matches(UUID, id))))) &&
      policy.codex.some(row => row.peer === peer && (id === null || row.ids === "all" || row.ids.includes(id)));
  } catch { return false; }
}

function providerPath() {
  const binary = path.join(installationRoot(), "provider", process.platform === "win32" ? "codex.exe" : "codex");
  const resolved = fs.realpathSync.native(binary);
  if (path.relative(binary, resolved) !== "" || !fs.statSync(binary).isFile()) throw new Error("provider_unavailable");
  fs.accessSync(binary, fs.constants.X_OK);
  return binary;
}

async function queue(id, text) {
  const binary = providerPath();
  const windows = process.platform === "win32";
  const profile = os.homedir();
  const env = { HOME: profile, CODEX_HOME: path.join(profile, ".codex") };
  if (windows) Object.assign(env, { USERPROFILE: profile, SystemRoot: process.env.SystemRoot,
    PATH: path.join(process.env.SystemRoot, "System32") });
  const child = spawn(binary, ["queue", "--thread", id, "--message", text], {
    cwd: path.dirname(binary), env, shell: false, windowsHide: true, detached: !windows, stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise(resolve => {
    let done = false;
    let stdout = "";
    let size = 0;
    function finish(state) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(state);
    }
    function abort() {
      if (done) return;
      if (child.pid && child.exitCode === null) {
        if (windows) {
          const killer = spawn(path.join(env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
            { shell: false, windowsHide: true, stdio: "ignore" });
          killer.on("error", () => child.kill());
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
        }
      }
      finish("unknown");
    }
    const timer = setTimeout(abort, 35000);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 4096) abort();
      else stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish("provider_unavailable"));
    child.once("close", code => {
      const parts = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.?$/i.exec(stdout.trim());
      finish(code === 0 && parts && matches(UUID, parts[1]) && parts[2] === id ? "queued" : "unknown");
    });
  });
}

export async function dispatchRemote(request, peer, {
  allowed = policyAllows, list = inventory, check = codexQueueBlock, reference = resolveCodexReference,
  available = providerPath, run = queue, receipts = () => openReceipts(path.join(installationRoot(), "receipts.sqlite")),
  now = Date.now,
} = {}) {
  const id = request.to ?? null;
  if (!allowed(peer, id)) return "receive_denied";
  let store;
  let reserved = false;
  let hash;
  try {
    if (request.op === "status") {
      store = await receipts();
      return store.status(peer, request.requestId);
    }
    if (request.op === "send") {
      store = await receipts();
      hash = requestDigest(request);
      const state = store.reserve(peer, request.requestId, hash, now());
      if (state !== "reserved") return state;
      reserved = true;
    }
    function finish(state) {
      if (reserved) store.finish(peer, request.requestId, hash, state);
      return state;
    }
    const snapshot = await list();
    const targets = snapshot.targets.filter(row => row.id === id);
    if (targets.length !== 1) return finish("unresolved");
    const target = targets[0];
    if (target.kind !== "codex") return finish("restricted_route");
    if (!matches(UUID, id) || !target.addressable) return finish("unaddressable");
    try { available(); } catch { return finish("provider_unavailable"); }
    let quote = null;
    if (request.re) {
      quote = await reference(id, request.re);
      if (!quote.ok) return finish("reference_unresolved");
    }
    const blocked = await check(id);
    if (blocked) return finish("unaddressable");
    if (request.op === "resolve") return "eligible";
    if (!allowed(peer, id)) return finish("receive_denied");
    const text = remoteEnvelope(request, peer, quote);
    // Windows quoting can double every character in the worst case. Leave room for the image path and fixed argv.
    if (text.length * 2 + 1024 > 32767) return finish("message_too_large");
    return finish(await run(id, text));
  } catch { return reserved ? "unknown" : "unavailable"; }
  finally { store?.close(); }
}
