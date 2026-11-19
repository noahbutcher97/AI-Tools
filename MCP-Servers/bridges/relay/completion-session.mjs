import { spawn } from "node:child_process";
import path from "node:path";
import { exactKeys, matches, UUID } from "./delivery-protocol.mjs";
import { validExit } from "./completion-protocol.mjs";

const handlePattern = /^local-proof\.[A-Za-z0-9_-]{39,8180}$/;
const handleOk = value => matches(handlePattern, value);
export function completionText(value) {
  const suffix = " No reply is needed.";
  if (typeof value !== "string" || value.length > 1024 || !value.endsWith(suffix)) return false;
  const lines = value.slice(0, -suffix.length).split("\n");
  return lines.length <= 8 && lines.every(line => {
    const match = /^Job ([a-f0-9-]+) ended with (exit code (-?\d+)|signal (SIG[A-Z0-9]+))\.$/.exec(line);
    if (!match || !matches(UUID, match[1])) return false;
    if (match[4]) return validExit({ code: null, signal: match[4] });
    const code = Number(match[3]);
    return String(code) === match[3] && validExit({ code, signal: null });
  });
}

function validTarget(t, to) {
  return exactKeys(t, ["id", "kind", "pid", "startedAt", "addressable"]) && t.id === to && t.kind === "claude" &&
    Number.isSafeInteger(t.pid) && t.pid > 0 && Number.isSafeInteger(t.startedAt) && t.startedAt > 0 && t.addressable === true;
}

export function frameIO(input, output) {
  const reader = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  return {
    async read() {
      for (;;) {
        const end = pending.indexOf(10);
        if (end >= 0) {
          if (end > 12288) throw new Error("oversize session frame");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end));
          pending = pending.subarray(end + 1);
          const value = JSON.parse(text);
          if (JSON.stringify(value) !== text) throw new Error("invalid session frame");
          return value;
        }
        if (pending.length > 12288) throw new Error("oversize session frame");
        const chunk = await reader.next();
        if (chunk.done) throw new Error("session channel closed");
        pending = Buffer.concat([pending, chunk.value]);
      }
    },
    write(value) {
      const frame = JSON.stringify(value);
      if (Buffer.byteLength(frame) > 12288) throw new Error("oversize session frame");
      return new Promise((resolve, reject) => output.write(frame + "\n", error => error ? reject(error) : resolve()));
    },
  };
}

// Only the native helper opens a named pipe or starts a scheduled task.
function nativeExchange(root) {
  return async (operation, signal) => {
    signal?.throwIfAborted();
    const child = spawn(path.join(root, "CompletionChannel.exe"), ["broker"], { cwd: root, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.on("error", () => {});
    const closed = new Promise(resolve => {
      child.once("error", () => resolve(false));
      child.once("close", code => resolve(code === 0));
    });
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(stop, 57000);
    try {
      const result = await operation(frameIO(child.stdout, child.stdin));
      child.stdin.end();
      if (!await closed) throw new Error("session channel failed");
      return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      if (child.exitCode === null && child.signalCode === null) stop();
      await closed;
    }
  };
}

export function sessionDelivery(root, exchange = nativeExchange(root)) {
  return {
    async check(signal) {
      return exchange(async io => {
        await io.write({ op: "check" });
        const reply = await io.read();
        if (!exactKeys(reply, ["op", "state"]) || reply.op !== "done" || reply.state !== "ready") {
          throw new Error("session worker unavailable");
        }
        return true;
      }, signal);
    },
    async send(to, body, { checkTarget, onHandle, signal }) {
      let reserved = false;
      if (!matches(UUID, to) || !completionText(body)) throw new Error("invalid job notice");
      try {
        return await exchange(async io => {
          await io.write({ op: "send", to, body });
          const first = await io.read();
          if (!exactKeys(first, ["op", "target"]) || first.op !== "target" || !validTarget(first.target, to)) throw new Error();
          await checkTarget(first.target);
          await io.write({ op: "capture" });
          const next = await io.read();
          if (!exactKeys(next, ["op", "handle"]) || next.op !== "handle" || !handleOk(next.handle)) throw new Error();
          await onHandle(next.handle, first.target);
          reserved = true;
          signal?.throwIfAborted();
          await io.write({ op: "submit" });
          const result = await io.read();
          if (!exactKeys(result, ["op", "state"]) || result.op !== "done" || result.state !== "submitted") throw new Error();
          return { state: "pending" };
        }, signal);
      } catch { return { state: reserved ? "unknown" : "dispatch_failed" }; }
    },
    async status(handle, { signal } = {}) {
      if (!handleOk(handle)) return { state: "proof_unavailable" };
      try {
        return await exchange(async io => {
          await io.write({ op: "status", handle });
          const reply = await io.read();
          if (!exactKeys(reply, ["op", "to", "state"]) || reply.op !== "done" || !matches(UUID, reply.to) ||
              !["pending","delivered","proof_unavailable"].includes(reply.state)) throw new Error();
          return { state: reply.state, to: reply.to };
        }, signal);
      } catch { return { state: "proof_unavailable" }; }
    },
  };
}

// The session worker receives one typed operation from an authenticated broker.
export async function serveSession(io, { send, status, enabled = () => true }) {
  try {
    const req = await io.read();
    if (exactKeys(req, ["op"]) && req.op === "check") {
      await io.write({ op: "done", state: "ready" });
      return;
    }
    if (!enabled()) throw new Error();
    if (exactKeys(req, ["op", "handle"]) && req.op === "status" && handleOk(req.handle)) {
      const proof = await status(req.handle);
      if (!matches(UUID, proof.to) || !["pending","delivered","proof_unavailable"].includes(proof.state)) throw new Error();
      await io.write({ op: "done", to: proof.to, state: proof.state });
      return;
    }
    if (!exactKeys(req, ["op", "to", "body"]) || req.op !== "send" || !matches(UUID, req.to) || !completionText(req.body)) throw new Error();
    let phase = 0;
    const result = await send(req.to, req.body, { allowDelegate: true, deferProof: true,
      async checkTarget(t) {
        const target = { id: t.id, kind: t.kind, pid: t.pid, startedAt: t.startedAt, addressable: t.addressable };
        if (phase++ !== 0 || !validTarget(target, req.to) || !matches(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, t.name)) throw new Error();
        await io.write({ op: "target", target });
        const ack = await io.read();
        if (!exactKeys(ack, ["op"]) || ack.op !== "capture" || !enabled()) throw new Error();
      },
      async onHandle(handle) {
        if (phase++ !== 1 || !handleOk(handle)) throw new Error();
        await io.write({ op: "handle", handle });
        const ack = await io.read();
        if (!exactKeys(ack, ["op"]) || ack.op !== "submit" || !enabled()) throw new Error();
      },
    });
    if (phase !== 2 || result.state !== "pending") throw new Error();
    await io.write({ op: "done", state: "submitted" });
  } catch { await io.write({ op: "failed" }); }
}
