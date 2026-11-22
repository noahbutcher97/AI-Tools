import { TextDecoder } from "node:util";
import { MAX_FRAME, validDeliveryFrame } from "./delivery-protocol.mjs";
import { validLookupFrame, validLookupReply } from "./lookup-protocol.mjs";
import { lookupInstalled } from "./remote-lookup-receiver.mjs";

const MAX_PROBE_BYTES = 512;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function decodeRequest(bytes) {
  if (!bytes.length || bytes.length > MAX_FRAME) throw new Error("invalid_frame");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const request = JSON.parse(text);
  if (request?.v === 2 || request?.v === 3) {
    // Compact JSON from the protocol encoder round-trips exactly. Duplicate
    // members, escaped keys and extra frames cannot disappear during parsing.
    if (text !== JSON.stringify(request) || !(request.v === 3 ? validLookupFrame(request) : validDeliveryFrame(request))) {
      throw new Error("invalid_frame");
    }
    return request;
  }
  // Version 1 probe frames have three ASCII-only members and no escapes.
  // Count keys before trusting JSON.parse, which discards duplicate members.
  if (bytes.length > MAX_PROBE_BYTES || !request || typeof request !== "object" || Array.isArray(request) ||
      text.includes("\\") || [...text.matchAll(/"[^"]*"\s*:/g)].length !== 3 ||
      Object.keys(request).length !== 3 || request.v !== 1 ||
      !["probe", "inventory", "readiness"].includes(request.op) || typeof request.requestId !== "string" ||
      !UUID.test(request.requestId)) throw new Error("invalid_frame");
  return request;
}

export async function receive(args, originalCommand, input, timeoutMs = 3000, inventory, dispatch, readiness, lookup = lookupInstalled) {
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
      if (size > MAX_FRAME) return { ok: false, error: "invalid_frame" };
      chunks.push(chunk);
    }
    const request = decodeRequest(Buffer.concat(chunks));
    clearTimeout(timer);
    const reply = { ok: true, v: request.v, op: request.op, requestId: request.requestId, host: args[3], peer: args[1] };
    if (request.v === 3) {
      if (request.host !== reply.host || reply.peer === reply.host) return { ok: false, error: "receive_denied" };
      const result = await lookup(request, reply.peer);
      const response = { ...reply, state: result?.state };
      if (result?.state === "resolved") response.target = result.target;
      if (result?.state === "ambiguous" && Object.hasOwn(result, "adapters")) response.adapters = result.adapters;
      return validLookupReply(response, request, reply.peer) ? response : { ...reply, state: "unavailable" };
    }
    if (request.v === 2) {
      if (!dispatch || request.host !== args[3] || args[1] === args[3]) return { ok: false, error: "receive_denied" };
      return { ...reply, state: await dispatch(request, args[1]) };
    }
    if (request.op === "readiness") {
      if (!readiness) return { ok: false, error: "unsupported_operation" };
      const { record, build } = readiness();
      return { ...reply, record, build, time: new Date().toISOString() };
    }
    if (request.op === "inventory") {
      if (!inventory) return { ok: false, error: "unsupported_operation" };
      const result = await inventory();
      return { ...reply, ...result };
    }
    return reply;
  } catch {
    return { ok: false, error: expired ? "deadline" : "invalid_frame" };
  } finally {
    clearTimeout(timer);
  }
}
