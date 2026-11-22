import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveClaudeCommand, resolveCodexCommand } from "./client.mjs";
import { digest, exactKeys, matches, UUID } from "./delivery-protocol.mjs";
import { installationRoot, inventory, loadDirectory, requestHost } from "./fleet.mjs";
import { localPing, localStatus } from "./local-ping.mjs";
import { runProvider } from "./provider-process.mjs";
import { readWatcher, validWatcherObservation } from "./watcher-health.mjs";

const FRESH_MS = 5 * 60_000;
const SMOKE_MS = 24 * 60 * 60_000;
const hash = /^[0-9a-f]{64}$/;
const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const stamp = ms => new Date(ms).toISOString();

export function buildFingerprint(root = fileURLToPath(new URL(".", import.meta.url))) {
  const files = fs.readdirSync(root).filter(name => name === "package-lock.json" || name === "completion-acl.ps1" || name === "private-spool.ps1" || name === "CompletionChannel.cs" ||
    (name.endsWith(".mjs") && !name.endsWith(".test.mjs"))).sort();
  return digest(JSON.stringify(files.map(name => {
    const source = fs.readFileSync(path.join(root, name), "utf8").replaceAll("\r\n", "\n");
    return [name, digest(source)];
  })));
}
export const loadedBuild = buildFingerprint();
const setupFields = ["hostPins", "relayKey", "receivePolicy", "providerImage", "receiptStore"];
function inspectSetup(profile) {
  const root = installationRoot();
  const files = ["known_hosts", null, "receive-policy.json", path.join("provider", process.platform === "win32" ? "codex.exe" : "codex"), "receipts.sqlite"];
  return Object.fromEntries(setupFields.map((name, i) => {
    const file = files[i] ? path.join(root, files[i]) : path.join(profile, ".cross-agent-relay", "ssh", "identity");
    try { return [name, fs.lstatSync(file).isFile() ? "present" : "unavailable"]; }
    catch { return [name, "unavailable"]; }
  }));
}

function trustedState(profile, name, create) {
  const root = path.join(profile, ".cross-agent-relay");
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (path.relative(root, fs.realpathSync.native(root)) !== "") throw new Error("invalid state directory");
  return path.join(root, name);
}
function readState(profile, name) {
  const file = trustedState(profile, name, false);
  if (path.relative(file, fs.realpathSync.native(file)) !== "") throw new Error("invalid state path");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) throw new Error("invalid state");
    const bytes = Buffer.alloc(st.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("incomplete state");
    return JSON.parse(bytes.toString("utf8"));
  } finally { fs.closeSync(fd); }
}
function writeState(profile, name, record) {
  const file = trustedState(profile, name, true);
  const temp = path.join(path.dirname(file), randomUUID() + ".tmp");
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(record) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

const authStates = ["signed_in", "signed_out", "expired", "unavailable", "check_failed"];
const expiryStates = ["reported", "not_exposed", "unavailable"];
function auth(state, expiresAt = null) {
  return { state, expiresAt, expiry: expiresAt ? "reported" : state === "signed_in" ? "not_exposed" : "unavailable" };
}

export async function providerAuth(kind, { run = runProvider, resolve, now = Date.now() } = {}) {
  try {
    const launcher = resolve ? resolve(kind) : kind === "codex" ? resolveCodexCommand() : { command: resolveClaudeCommand(), prefix: [] };
    if (!launcher?.command) return auth("unavailable");
    const args = kind === "codex" ? ["login", "status"] : ["auth", "status", "--json"];
    const out = await run(launcher.command, [...launcher.prefix, ...args], { cwd: os.homedir(), timeoutMs: 4500, maxBytes: 32768 });
    if (kind === "codex") {
      const text = [out.stdout, out.stderr].join("\n");
      if (/^not logged in\b/im.test(text)) return auth("signed_out");
      return auth(out.code === 0 && /^logged in\b/im.test(text) ? "signed_in" : "check_failed");
    }
    const data = JSON.parse(out.stdout);
    if (data.loggedIn === false) return auth("signed_out");
    if (data.loggedIn !== true || out.code !== 0) return auth("check_failed");
    let expiry = null;
    if (typeof data.loginExpiresAt === "string" && Number.isFinite(Date.parse(data.loginExpiresAt))) {
      expiry = stamp(Date.parse(data.loginExpiresAt));
    }
    return auth(expiry && Date.parse(expiry) <= now ? "expired" : "signed_in", expiry);
  } catch { return auth("check_failed"); }
}

function validAuth(value) {
  return exactKeys(value, ["state", "expiresAt", "expiry"]) && authStates.includes(value.state) &&
    expiryStates.includes(value.expiry) && (value.expiresAt === null || date(value.expiresAt)) &&
    (value.expiry === "reported") === Boolean(value.expiresAt);
}

export function validRecord(r) {
  const keys = ["v","checkedAt","validUntil","build","protocol","directoryRevision","inventory","providers","delegate","setup","status"];
  if (r?.v === 2) keys.push("watcher");
  return exactKeys(r, keys) && [1,2].includes(r.v) && r.protocol === 2 && date(r.checkedAt) && date(r.validUntil) &&
    (r.v === 1 || validWatcherObservation(r.watcher, Date.parse(r.checkedAt))) &&
    Date.parse(r.validUntil) - Date.parse(r.checkedAt) === FRESH_MS && matches(hash, r.build) &&
    (r.directoryRevision === null || matches(hash, r.directoryRevision)) &&
    ["available","partial","unavailable"].includes(r.inventory) && exactKeys(r.providers, ["claude","codex"]) &&
    validAuth(r.providers.claude) && validAuth(r.providers.codex) && exactKeys(r.delegate, ["state","checkedAt"]) &&
    ["not_checked","pending","delivered","proof_unavailable","dispatch_failed","stale"].includes(r.delegate.state) &&
    (r.delegate.checkedAt === null ? r.delegate.state === "not_checked" : date(r.delegate.checkedAt)) &&
    exactKeys(r.setup, setupFields) && setupFields.every(k => ["present","unavailable"].includes(r.setup[k])) &&
    ["ready","degraded"].includes(r.status);
}

export function readReadiness(profile = os.homedir()) {
  try {
    const record = readState(profile, "readiness.json");
    return validRecord(record) ? record : null;
  } catch { return null; }
}

function designatedTarget() {
  const f = path.join(installationRoot(), "doctor-target.json");
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  return exactKeys(data, ["claude"]) && matches(UUID, data.claude) ? data.claude : null;
}

async function delegateSmoke(profile, target, now, { ping, status, designated, list }) {
  let evidence;
  if (target) {
    if (!matches(UUID, target) || designated() !== target) throw new Error("probe target is not designated");
    const snapshot = await list();
    const rows = snapshot.targets.filter(t => t.id === target);
    if (rows.length !== 1 || rows[0].kind !== "claude" || !rows[0].addressable) throw new Error("designated target unavailable");
    const result = await ping(target, { allowDelegate: true, profile });
    evidence = { checkedAt: stamp(now), state: result.state ?? "dispatch_failed", handle: result.handle ?? null };
    writeState(profile, "delegate-proof.json", evidence);
  } else {
    try { evidence = readState(profile, "delegate-proof.json"); } catch { return { state: "not_checked", checkedAt: null }; }
  }
  if (!date(evidence.checkedAt)) return { state: "not_checked", checkedAt: null };
  if (now < Date.parse(evidence.checkedAt) || now - Date.parse(evidence.checkedAt) > SMOKE_MS) return { state: "stale", checkedAt: evidence.checkedAt };
  let state = evidence.state;
  if (state === "pending" && evidence.handle) state = (await status(evidence.handle, { profile })).state;
  if (!["pending","delivered","dispatch_failed","proof_unavailable"].includes(state)) state = "proof_unavailable";
  return { state, checkedAt: evidence.checkedAt };
}

export async function checkReadiness({ profile = os.homedir(), now = Date.now(), target, directory = loadDirectory,
  list = inventory, check = providerAuth, ping = localPing, status = localStatus, designated = designatedTarget } = {}) {
  const watcher = readWatcher(installationRoot(), now);
  let directoryRevision = null;
  try {
    const rows = directory().hosts.map(row => [row.host, row.endpoint, row.user, row.port]).sort((a,b) => a[0].localeCompare(b[0], "en"));
    directoryRevision = digest(JSON.stringify(rows));
  } catch { /* Local provider checks remain available without a fleet directory. */ }
  const [claude, codex, inventoryState, delegate] = await Promise.all([
    check("claude", { now }), check("codex", { now }), list().then(r => r.partial ? "partial" : "available").catch(() => "unavailable"),
    delegateSmoke(profile, target, now, { ping, status, designated, list }),
  ]);
  const setup = inspectSetup(profile);
  const ready = Object.values(setup).every(x => x === "present") && directoryRevision && inventoryState === "available" && claude.state === "signed_in" && codex.state === "signed_in" &&
    delegate.state === "delivered" && watcher.state === "watching";
  const record = { v: 2, checkedAt: stamp(now), validUntil: stamp(now + FRESH_MS), build: loadedBuild, protocol: 2,
    directoryRevision, inventory: inventoryState, providers: { claude, codex }, delegate, setup, watcher, status: ready ? "ready" : "degraded" };
  if (!validRecord(record)) throw new Error("invalid readiness record");
  writeState(profile, "readiness.json", record);
  return record;
}

export async function fleetReadiness({ directory, query = requestHost, local = readReadiness(),
  now = Date.now, profile = os.homedir(), persist = false } = {}) {
  if (directory === undefined) {
    try { directory = loadDirectory(); } catch { directory = null; }
  }
  if (!directory) {
    const report = { v: 1, checkedAt: stamp(now()), ready: false, reason: "directory_unavailable",
      hosts: [], local: validRecord(local) ? local : null };
    if (persist) writeState(profile, "fleet-readiness.json", report);
    return report;
  }
  const hosts = await Promise.all(directory.hosts.map(async entry => {
    const host = entry.host, start = now();
    let record = local, skewMs = 0, uncertaintyMs = 0;
    if (host !== directory.local) {
      try {
        const frame = { v: 1, op: "readiness", requestId: randomUUID() };
        const { reply, error } = await query(entry, frame, 3000);
        if (error) return { host, status: error };
        if (!exactKeys(reply, ["ok","v","op","requestId","host","peer","record","time","build"]) ||
            reply.ok !== true || reply.v !== 1 || reply.op !== frame.op || reply.requestId !== frame.requestId ||
            reply.host !== host || reply.peer !== directory.local || !date(reply.time) ||
            !matches(hash, reply.build)) return { host, status: "invalid_response" };
        if (reply.build !== loadedBuild) return { host, status: "build_mismatch" };
        const end = now();
        uncertaintyMs = Math.ceil((end - start) / 2);
        skewMs = Math.round(Date.parse(reply.time) - (start + end) / 2);
        record = reply.record;
      } catch { return { host, status: "unavailable" }; }
    }
    if (record === null) return { host, status: "no_readiness" };
    if (!validRecord(record)) return { host, status: "invalid_response" };
    let status = record.status;
    if (Math.abs(skewMs) + uncertaintyMs > 30000) status = "clock_skew";
    else if (now() + skewMs + uncertaintyMs > Date.parse(record.validUntil)) status = "stale";
    else if (local && record.build !== local.build) status = "build_mismatch";
    else if (local && record.directoryRevision !== local.directoryRevision) status = "directory_mismatch";
    return { host, status, skewMs, uncertaintyMs, record };
  }));
  const report = { v: 1, checkedAt: stamp(now()), hosts, ready: hosts.every(row => row.status === "ready") };
  if (persist) writeState(profile, "fleet-readiness.json", report);
  return report;
}
