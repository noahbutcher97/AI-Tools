import fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openCompletionJobs } from "./completion-jobs.mjs";
import { prepareJobRequest } from "./completion-protocol.mjs";
import { sessionDelivery } from "./completion-session.mjs";
import { digest, exactKeys, matches, UUID } from "./delivery-protocol.mjs";
import { writeHeartbeat } from "./watcher-health.mjs";
import { publishRunHandoff } from "./run-handoff.mjs";

const PORT = 44197;
const MAX_BYTES = 768;
const DEADLINE = 2000;

function loopback() {
  for (const entry of Object.values(os.networkInterfaces()).flat()) {
    if (entry?.internal && net.isIPv4(entry.address) && entry.address.split(".")[0] === "127") return entry.address;
  }
  throw new Error("local job transport unavailable");
}

async function readFrame(socket) {
  // Keep the write half alive after the peer sends EOF. The stream async
  // iterator can destroy a duplex socket before the acknowledgement is sent.
  const chunks = await new Promise((resolve, reject) => {
    let bytes = 0;
    const parts = [];
    socket.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) socket.destroy(new Error("oversize job frame"));
      else parts.push(chunk);
    });
    socket.once("end", () => resolve(parts));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("incomplete job frame")));
  });
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  const value = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw new Error("invalid job frame");
  return value;
}

// No host option. The private service launcher owns the store and the port.
// The socket can submit one bounded frame and receives no local diagnostics.
export async function listenForJobReports(accept, { port = PORT } = {}) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), DEADLINE);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    void (async () => {
      try {
        const frame = await readFrame(socket);
        socket.end(JSON.stringify(accept(frame)));
      } catch {
        if (!socket.destroyed) socket.end("{}");
      }
    })();
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: loopback(), port, exclusive: true }, resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}

export async function reportJob(grant, op, event = null, { port = PORT } = {}) {
  const request = prepareJobRequest(grant, op, event);
  const socket = net.createConnection({ host: loopback(), port, allowHalfOpen: true });
  const timer = setTimeout(() => socket.destroy(new Error("job broker timeout")), DEADLINE);
  try {
    socket.end(JSON.stringify(request.frame));
    if (!request.accepts(await readFrame(socket))) throw new Error();
  } catch {
    throw new Error("job broker unavailable or report denied");
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

function underRoot(root, name) {
  const file = path.join(root, name);
  if (path.relative(file, fs.realpathSync.native(file)) !== "") throw new Error("unexpected broker file");
  return file;
}

// The service launcher provisions the directory ACLs before startup. The
// policy is replaced atomically by the separate policy authority.
function readJobPolicy(root) {
  const file = underRoot(root, "completion-policy.json");
  const fd = fs.openSync(file, "r");
  let policy;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 32768) throw new Error("invalid job policy");
    const bytes = Buffer.alloc(32769);
    const n = fs.readSync(fd, bytes);
    if (n !== stat.size) throw new Error("invalid job policy");
    policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)));
  } finally { fs.closeSync(fd); }
  const valid = exactKeys(policy, ["v", "grants"]) && policy.v === 1 && Array.isArray(policy.grants) &&
    policy.grants.length <= 128 && policy.grants.every(g => exactKeys(g, ["id", "provider", "instance"]) &&
      matches(UUID, g.id) && g.provider === "claude" && matches(/^[a-f0-9]{64}$/, g.instance));
  if (!valid) throw new Error("invalid job policy");
  return policy.grants;
}

export function loadJobPolicy(root) {
  return (id, provider, instance) => {
    try {
      return readJobPolicy(root).some(g => g.id === id && g.provider === provider && g.instance === instance);
    } catch { return false; }
  };
}

export async function provisionRun(root, session, count, expiry) {
  const validUntil = Date.parse(expiry);
  if (!matches(UUID, session) || !matches(/^[1-8]$/, count) || !Number.isFinite(validUntil) ||
      new Date(validUntil).toISOString() !== expiry || validUntil <= Date.now()) throw new Error("invalid grant request");
  const authorized = readJobPolicy(root).filter(g => g.id === session);
  if (authorized.length !== 1) throw new Error("an exclusive authorized instance is required");
  const store = await openCompletionJobs(underRoot(root, path.join("completion-state", "jobs.sqlite")), {
    permits: loadJobPolicy(root),
  });
  try {
    return store.provision(session, authorized[0].instance, Number(count), validUntil,
      (binding, hash, pending) => publishRunHandoff(root, binding, hash, pending));
  } finally { store.close(); }
}

export async function startCompletionBroker(root, { port, delivery, publishHealth = false } = {}) {
  // Only the trusted process launcher supplies these adapters. The production
  // broker account must never fall back to spawning a provider in its profile.
  if (delivery !== undefined && (typeof delivery?.send !== "function" || typeof delivery.status !== "function")) {
    throw new Error("incomplete delivery adapter");
  }
  const unavailable = () => { throw new Error("session-profile delivery unavailable"); };
  const store = await openCompletionJobs(underRoot(root, path.join("completion-state", "jobs.sqlite")), {
    send: delivery?.send ?? unavailable, status: delivery?.status ?? unavailable, permits: loadJobPolicy(root),
  });
  let listener;
  try { listener = await listenForJobReports(store.acceptFrame, { port }); }
  catch (err) { store.close(); throw err; }
  const controller = new AbortController();
  const { signal } = controller;
  const startedAt = new Date().toISOString();
  function publish(mode) {
    try {
      let policyRevision = null;
      const file = underRoot(root, "completion-policy.json");
      if (fs.statSync(file).size <= 32768) policyRevision = digest(fs.readFileSync(file));
      writeHeartbeat(root, { v: 1, pid: process.pid, startedAt, heartbeat: new Date().toISOString(), mode, policyRevision,
        ...store.subscriptions() });
    } catch { /* A missing or stale heartbeat remains visible to doctor. */ }
  }
  const mode = delivery ? "watching" : "reports_only";
  if (publishHealth) publish(mode);
  const heartbeat = publishHealth ? setInterval(() => publish(mode), 5000) : undefined;
  async function watch() {
    while (!signal.aborted) {
      let worked = false;
      try { worked = await store.dispatchDue(signal); }
      catch { /* A reserved dispatch stays uncertain; other jobs still run. */ }
      try { await delay(worked ? 0 : 500, undefined, { signal }); } catch { return; }
    }
  }
  const running = delivery ? watch() : Promise.resolve();
  let closing;
  return { port: listener.port, close() {
    if (!closing) {
      controller.abort();
      clearInterval(heartbeat);
      // Retain exclusive ownership of the listener through the final callback.
      closing = running.then(() => {
        if (publishHealth) publish("stopped");
        return listener.close();
      }).finally(() => store.close());
    }
    return closing;
  } };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const checkOnly = process.argv.length === 3 && process.argv[2] === "--check-worker";
    const provision = process.argv.length === 6 && process.argv[2] === "--provision-run";
    if ((!checkOnly && !provision && process.argv.length !== 2) || process.platform !== "win32") throw new Error();
    const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const verifier = fileURLToPath(new URL("./completion-acl.ps1", import.meta.url));
    const checked = JSON.parse(execFileSync(shell, ["-NoProfile", "-NonInteractive", "-File", verifier], {
      encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }));
    if (!path.isAbsolute(checked.root)) throw new Error();
    if (provision) {
      if (checked.handoff !== true) throw new Error();
      const result = await provisionRun(checked.root, ...process.argv.slice(3));
      console.log(JSON.stringify(result));
    } else if (checkOnly) {
      if (!checked.installed || !await sessionDelivery(checked.root).check()) throw new Error();
      console.log("Authenticated desktop worker ready.");
    } else {
      const delivery = checked.enabled === true ? sessionDelivery(checked.root) : undefined;
      const broker = await startCompletionBroker(checked.root, { delivery, publishHealth: checked.health === true });
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void broker.close());
    }
  } catch {
    console.error("Completion broker unavailable. Check protected installation, storage and local listener.");
    process.exitCode = 1;
  }
}
