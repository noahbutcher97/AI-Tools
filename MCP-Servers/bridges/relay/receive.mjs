import { TextDecoder } from "node:util";

const MAX_PROBE_BYTES = 512;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function decodeProbe(bytes) {
  if (!bytes.length || bytes.length > MAX_PROBE_BYTES) throw new Error("invalid_frame");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const request = JSON.parse(text);
  // Version 1 probe frames have three ASCII-only members and no escapes.
  // Count keys before trusting JSON.parse, which discards duplicate members.
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      text.includes("\\") || [...text.matchAll(/"[^"]*"\s*:/g)].length !== 3 ||
      Object.keys(request).length !== 3 || request.v !== 1 ||
      request.op !== "probe" || typeof request.requestId !== "string" ||
      !UUID.test(request.requestId)) throw new Error("invalid_frame");
  return request;
}

export async function receive(args, originalCommand, input, timeoutMs = 3000) {
  if (originalCommand !== "relay receive" || args.length !== 4 ||
      args[0] !== "--peer" || args[2] !== "--host" ||
      !LABEL.test(args[1]) || !LABEL.test(args[3])) {
    return { ok: false, error: "receive_denied" };
  }
  const chunks = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    input.destroy(new Error("deadline"));
  }, timeoutMs);
  try {
    for await (const chunk of input) {
      size += chunk.length;
      if (size > MAX_PROBE_BYTES) return { ok: false, error: "invalid_frame" };
      chunks.push(chunk);
    }
    const request = decodeProbe(Buffer.concat(chunks));
    return { ok: true, v: 1, op: "probe", requestId: request.requestId, host: args[3], peer: args[1] };
  } catch {
    return { ok: false, error: expired ? "deadline" : "invalid_frame" };
  } finally {
    clearTimeout(timer);
  }
}
