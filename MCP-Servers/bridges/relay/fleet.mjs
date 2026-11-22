import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { discoverTargets } from "./client.mjs";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_HOSTS = 32;
const MAX_TARGETS = 256;
export const INVENTORY_SURVEY_MS = 2300;
const MAX_RESPONSE = 128 * 1024;
const validLabel = (value) => typeof value === "string" && LABEL.test(value);

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseDirectory(machine, entries) {
  if (!exactKeys(machine, ["host"]) || !validLabel(machine.host) ||
      !Array.isArray(entries) || !entries.length || entries.length > MAX_HOSTS) {
    throw new Error("invalid host directory");
  }
  const labels = new Set();
  for (const entry of entries) {
    if (!exactKeys(entry, ["host", "endpoint", "port", "user"]) || !validLabel(entry.host) ||
        typeof entry.endpoint !== "string" || entry.endpoint.length > 253 ||
        !(net.isIP(entry.endpoint) || entry.endpoint.split(".").every(validLabel)) ||
        !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 ||
        typeof entry.user !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.user) ||
        labels.has(entry.host)) throw new Error("invalid host directory entry");
    labels.add(entry.host);
  }
  if (!labels.has(machine.host)) throw new Error("local host missing from directory");
  return { local: machine.host, hosts: entries };
}

export function installationRoot() {
  return process.platform === "win32" ? path.join(process.env.ProgramFiles, "CrossAgentRelay") : "/etc/cross-agent-relay";
}

export function loadDirectory() {
  const root = installationRoot();
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  return parseDirectory(read("machine.json"), read("hosts.json"));
}

// A provider database or directory read may block synchronously. Both fleet
// listing and exact receive surveys keep these reads off the receiver's loop.
function inventoryWorker(entrypoint, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(entrypoint, { workerData: data, execArgv: [] });
    const timer = setTimeout(() => {
      worker.unref();
      void worker.terminate();
      reject(new Error("inventory deadline"));
    }, INVENTORY_SURVEY_MS);
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("inventory worker exited"));
    });
  });
}

export async function surveyRemoteSelection(installed, selector, options) {
  try {
    return await inventoryWorker(new URL("./exact-survey-worker.mjs", import.meta.url),
      { enabled: installed.readerKinds, selector, options });
  } catch { return { ok: false, state: "incomplete_inventory" }; }
}

export async function inventory(options = {}) {
  if (isMainThread) return inventoryWorker(new URL(import.meta.url), { relayInventoryWorker: true, options });
  const { targets, warnings } = await discoverTargets({ scope: "all", ...options });
  const rows = [];
  let partial = warnings.length > 0;
  for (const row of targets) {
    if (typeof row.id !== "string" || !SESSION.test(row.id) || rows.length >= MAX_TARGETS) {
      partial = true;
      continue;
    }
    rows.push({
      id: row.id, kind: row.kind, status: row.status === "idle" && row.idleFor == null ? "unknown" : row.status,
      addressable: row.addressable && (row.kind !== "claude" || Boolean(row.name)),
    });
  }
  return { targets: rows, partial };
}

if (!isMainThread && parentPort && workerData?.relayInventoryWorker) {
  parentPort.postMessage(await inventory(workerData.options));
}

export function sshInvocation(entry) {
  const windows = process.platform === "win32";
  const command = windows ? path.join(process.env.SystemRoot, "System32", "OpenSSH", "ssh.exe") : "/usr/bin/ssh";
  const root = installationRoot();
  const pins = path.join(root, "known_hosts").replaceAll("\\", "/");
  const identity = path.join(os.homedir(), ".cross-agent-relay", "ssh", "identity");
  return { command, args: [
    "-F", "none", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=2",
    "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "PreferredAuthentications=publickey",
    "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no",
    "-o", "ProxyCommand=none", "-o", "GlobalKnownHostsFile=none", "-o", `UserKnownHostsFile="${pins}"`,
    "-o", `HostKeyAlias=${entry.host}`, "-i", identity, "-p", String(entry.port),
    "-l", entry.user, "--", entry.endpoint, "relay receive",
  ] };
}

export function requestHost(entry, request, timeoutMs = 3000, spawnProcess = spawn) {
  const { command, args } = sshInvocation(entry);
  return new Promise((resolve) => {
    // Windows OpenSSH uses overlapped I/O. Ordinary libuv pipes can leave
    // ssh waiting for input EOF or channel shutdown after a valid response.
    const channel = process.platform === "win32" ? "overlapped" : "pipe";
    const child = spawnProcess(command, args, { shell: false, windowsHide: true, stdio: [channel, channel, channel] });
    let error = null;
    let size = 0;
    const chunks = [];
    let diagnostics = "";
    const abort = (code) => { error = code; child.kill(); };
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE) abort("invalid_response");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (diagnostics.length < 4096) diagnostics += chunk.toString("utf8", 0, 4096 - diagnostics.length);
    });
    child.on("error", () => { error = "ssh_unavailable"; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (error) return resolve({ error });
      const lookup = request.v === 3 && request.op === "lookup";
      const output = Buffer.concat(chunks);
      if (code !== 0) {
        if (/host key verification failed|host identification has changed/i.test(diagnostics)) return resolve({ error: "host_key_error" });
        if (/permission denied/i.test(diagnostics)) return resolve({ error: "authentication_failed" });
        if (/timed out|no route to host|unreachable|connection refused|resolve hostname/i.test(diagnostics)) return resolve({ error: "offline" });
        // The previous receiver exits 1 for a version it cannot decode.
        if (lookup && code === 1 && /^\{"ok":false,"error":"invalid_frame"\}\r?\n$/.test(output.toString("utf8"))) {
          return resolve({ error: "lookup_refused" });
        }
        return resolve({ error: "receive_failed" });
      }
      try {
        const text = lookup ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output) : output.toString("utf8");
        const reply = JSON.parse(text);
        // The lookup receiver prints one compact JSON reply. Reject duplicate
        // members before the caller checks the request ID and selected target.
        if (lookup && text.replace(/\r?\n$/, "") !== JSON.stringify(reply)) return resolve({ error: "invalid_response" });
        resolve({ reply });
      }
      catch { resolve({ error: "invalid_response" }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function validInventory(reply) {
  return typeof reply.partial === "boolean" && Array.isArray(reply.targets) && reply.targets.length <= MAX_TARGETS &&
    reply.targets.every((t) => exactKeys(t, ["id", "kind", "status", "addressable"]) &&
      typeof t.id === "string" && SESSION.test(t.id) && ["claude", "codex"].includes(t.kind) &&
      ["idle", "busy", "unknown"].includes(t.status) && typeof t.addressable === "boolean");
}

export async function queryFleet(op, { directory = loadDirectory(), query = requestHost, localInventory = inventory } = {}) {
  if (!["probe", "inventory"].includes(op)) throw new Error("unsupported fleet operation");
  const hosts = await Promise.all(directory.hosts.map(async (entry) => {
    const host = entry.host;
    try {
      if (host === directory.local) return { host, status: "ready", ...(op === "inventory" ? await localInventory() : {}) };
      const request = { v: 1, op, requestId: randomUUID() };
      const { error, reply } = await query(entry, request);
      if (error) return { host, status: error };
      const keys = ["ok", "v", "op", "requestId", "host", "peer"];
      if (op === "inventory") keys.push("partial", "targets");
      if (!exactKeys(reply, keys) || reply.v !== 1 || reply.ok !== true || reply.op !== op ||
          reply.requestId !== request.requestId || reply.peer !== directory.local || reply.host !== host ||
          (op === "inventory" && !validInventory(reply))) return { host, status: "invalid_response" };
      return { host, status: "ready", ...(op === "inventory" ? { targets: reply.targets, partial: reply.partial } : {}) };
    } catch {
      return { host, status: "unavailable" };
    }
  }));
  return { hosts, complete: hosts.every((row) => row.status === "ready" && !row.partial),
    ...(op === "probe" ? { delivery: "not_attempted" } : {}) };
}
