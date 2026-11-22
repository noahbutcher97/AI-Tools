import { exactKeys, HOST, matches, UUID } from "./delivery-protocol.mjs";

// Literal IDs are compared as data. Controls, format characters and unpaired
// surrogates cannot identify a session on the wire.
export function validLookupId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 256 &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(id);
}

export function validLookupFrame(request) {
  if (request?.v !== 3 || request.op !== "lookup") return false;
  const keys = ["v", "op", "requestId", "host", "id"];
  if (Object.hasOwn(request, "adapter")) keys.push("adapter");
  return exactKeys(request, keys) && matches(UUID, request.requestId) && matches(HOST, request.host) &&
    validLookupId(request.id) && (!Object.hasOwn(request, "adapter") || matches(HOST, request.adapter));
}

export function validLookupReply(reply, request, peer) {
  if (!validLookupFrame(request) || !matches(HOST, peer) || peer === request.host ||
      reply?.ok !== true || reply.v !== request.v || reply.op !== request.op ||
      reply.requestId !== request.requestId || reply.host !== request.host || reply.peer !== peer) return false;
  const keys = ["ok", "v", "op", "requestId", "host", "peer", "state"];
  if (reply.state === "resolved") {
    const target = reply.target;
    return exactKeys(reply, [...keys, "target"]) && exactKeys(target, ["host", "adapter", "id"]) &&
      target.host === request.host && target.id === request.id && matches(HOST, target.adapter) &&
      (!Object.hasOwn(request, "adapter") || request.adapter === target.adapter);
  }
  return exactKeys(reply, keys) && ["ambiguous", "incomplete_inventory", "missing", "unknown_adapter",
    "receive_denied", "unavailable", "installation_changed"].includes(reply.state);
}
