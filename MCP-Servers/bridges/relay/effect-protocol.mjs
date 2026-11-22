import { exactKeys, HOST, matches, sendFields, UUID, validSendFields } from "./delivery-protocol.mjs";
import { validLookupId } from "./lookup-protocol.mjs";

const states = new Set(["eligible", "queued", "unknown", "missing", "unresolved", "unaddressable", "restricted_route",
  "receive_denied", "provider_unavailable", "reference_unresolved", "request_conflict", "receipts_full",
  "message_too_large", "request_expired", "unavailable", "pending", "delivered", "proof_unavailable"]);

export const validBoundEffectState = state => states.has(state);

export function validBoundEffectFrame(r) {
  if (r?.v !== 4 || !matches(UUID, r.requestId) || r.requestId[14] !== "7" ||
      !matches(HOST, r.host) || !matches(HOST, r.adapter) || !validLookupId(r.to)) return false;
  const common = ["v", "op", "requestId", "host", "adapter", "to"];
  if (r.op === "resolve") return exactKeys(r, [...common, "action"]) && ["send", "ping"].includes(r.action);
  if (r.op === "ping" || r.op === "status") return exactKeys(r, common);
  return r.op === "send" && exactKeys(r, [...common, ...sendFields]) && validSendFields(r);
}
