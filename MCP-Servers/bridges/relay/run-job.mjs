import { fork, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { reportJob } from "./completion-broker.mjs";
import { matches, UUID } from "./delivery-protocol.mjs";
import { availableGrant, validRunGrant } from "./run-handoff.mjs";

export class RunInputError extends Error {}

export async function readRunGrant(input, onEmpty) {
  if (input.isTTY && onEmpty) return onEmpty();
  if (input.isTTY) throw new RunInputError("A private job grant is required on stdin.");
  const timer = setTimeout(() => input.destroy(new Error("grant timeout")), 3000);
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of input) {
      size += Buffer.byteLength(chunk);
      if (size > 256) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    if (size === 0 && onEmpty) return onEmpty();
    const grant = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!validRunGrant(grant)) throw new Error();
    return grant;
  } catch { throw new RunInputError("A private job grant is required on stdin."); }
  finally { clearTimeout(timer); }
}

export function validCommand(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.length <= 1024 && typeof argv[0] === "string" &&
    argv[0].length > 0 && argv.every(s => typeof s === "string" && !s.includes("\0")) &&
    Buffer.byteLength(JSON.stringify(argv)) <= 65536;
}

// The caller owns execution. Only the status report is retried.
export async function observeCommand({ grant, session, argv, port }, notify, {
  report = reportJob, launch = spawn, pause = delay, connected = () => true,
} = {}) {
  if (!validRunGrant(grant) || !matches(UUID, session) || !validCommand(argv)) return notify("not_started");
  try { await report(grant, "claim_run", { session }, { port }); }
  catch { return notify("not_started"); }
  async function finish(op, event) {
    for (const backoff of [0, 250, 1000, 4000]) {
      if (backoff) await pause(backoff);
      try { await report(grant, op, event, { port }); return true; }
      catch { /* The same outcome is safe to repeat after a lost acknowledgement. */ }
    }
    return false;
  }
  let outcome;
  try {
    if (!connected()) throw new Error();
    const child = launch(argv[0], argv.slice(1), { shell: false, windowsHide: true, stdio: "ignore" });
    outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => notify("started"));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } catch {
    notify("not_started");
    return finish("start_failed", null);
  }
  return finish("complete", outcome);
}

export async function startRun(argv, identity, input, options = {}) {
  const { port } = options;
  if (!validCommand(argv)) throw new RunInputError("Use relay run -- <executable> [args...].");
  if (identity?.provider !== "claude" || !matches(UUID, identity.id)) throw new RunInputError("Run is unavailable in this session.");
  const grant = await readRunGrant(input, async () => {
    try { return await availableGrant(identity.id, reportJob, options); }
    catch { throw new RunInputError("No usable pre-issued job grant for this session."); }
  });
  // Keep the bearer out of argv, the child environment and the command's stdin.
  const worker = fork(fileURLToPath(import.meta.url), [], { detached: true, windowsHide: true, execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const state = await new Promise(resolve => {
    const timer = setTimeout(() => finish("unknown"), 6500);
    function finish(value) { clearTimeout(timer); resolve(value); }
    worker.once("error", () => finish("unknown"));
    worker.once("exit", () => finish("unknown"));
    worker.once("message", message => finish(["started", "not_started"].includes(message) ? message : "unknown"));
    worker.send({ argv, session: identity.id, grant, port }, err => { if (err) finish("unknown"); });
  });
  if (worker.connected) worker.disconnect();
  worker.unref();
  return { id: grant.id, state };
}

if (process.send && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const timer = setTimeout(() => process.disconnect?.(), 6500);
  process.once("message", job => {
    clearTimeout(timer);
    const notify = state => { if (process.connected) process.send(state, () => {}); };
    observeCommand(job, notify, { connected: () => process.connected }).catch(() => { process.exitCode = 1; });
  });
  process.once("disconnect", () => clearTimeout(timer));
}
