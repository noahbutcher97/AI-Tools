import { sendMessage } from "./client.mjs";
import { loadDirectory, requestHost } from "./fleet.mjs";
import { digest, exactKeys, matches, newRequestId, parseAddress, UUID, validDeliveryFrame } from "./delivery-protocol.mjs";

const states = new Set(["eligible", "queued", "unknown", "missing", "unresolved", "unaddressable", "restricted_route",
  "receive_denied", "provider_unavailable", "reference_unresolved", "request_conflict", "receipts_full",
  "message_too_large", "request_expired", "unavailable"]);

function failed(cause, extra = {}) { return { ok: false, cause, detail: cause.replaceAll("_", " "), ...extra }; }

async function exchange(entry, local, frame, query) {
  try {
    const { reply, error } = await query(entry, frame, frame.op === "send" ? 45000 : 5000);
    if (error) return { error };
    if (!exactKeys(reply, ["ok", "v", "op", "requestId", "host", "peer", "state"]) || reply.ok !== true ||
        reply.v !== 2 || reply.op !== frame.op || reply.requestId !== frame.requestId || reply.host !== entry.host ||
        reply.peer !== local || !states.has(reply.state)) return { error: "invalid_response" };
    return { state: reply.state };
  } catch { return { error: "transport_unavailable" }; }
}

export async function sendAddressed(options, { directory = loadDirectory, query = requestHost, local = sendMessage,
  onHandle = () => {} } = {}) {
  let address;
  try { address = parseAddress(options.to); } catch { return failed("invalid_address"); }
  if (!address.host) return options.requestId ? failed("request_id_requires_remote_host") : local(options);
  let fleet;
  try { fleet = directory(); } catch { return failed("directory_unavailable"); }
  if (address.host === fleet.local) return options.requestId ? failed("request_id_requires_remote_host") :
    local({ ...options, to: address.id, exactId: true });
  const entry = fleet.hosts.find(row => row.host === address.host);
  if (!entry) return failed("unknown_host");
  const requestId = options.requestId ?? newRequestId();
  if (!matches(UUID, requestId) || requestId[14] !== "7") return failed("invalid_request_id");
  const common = { v: 2, host: address.host, requestId };
  const frame = { ...common, op: "send", to: address.id, message: options.message,
    kind: options.kind ?? "notice", from: options.identity?.id ?? options.origin ?? null,
    conversation: options.conversation ?? null, inReplyTo: options.inReplyTo ?? null, re: options.re ?? null };
  if (!validDeliveryFrame(frame)) return failed("invalid_send_fields");
  const handle = address.host + ":" + requestId;
  const lookup = await exchange(entry, fleet.local, { ...common, op: "resolve", to: address.id }, query);
  if (lookup.state !== "eligible") return failed(lookup.error ?? lookup.state, { handle });
  if (options.dryRun) return { ok: true, to: options.to, state: "eligible", detail: "Resolved an eligible remote Codex target." };
  onHandle(handle);
  const result = await exchange(entry, fleet.local, frame, query);
  if (result.error || result.state === "unknown") return { ok: false, cause: "unknown", handle,
    detail: "Submission outcome unknown. Check ping --status " + handle + " before retrying." };
  if (result.state !== "queued") return failed(result.state, { handle });
  return { ok: true, to: options.to, state: "queued", handle, messageId: "m-" + requestId.replaceAll("-", ""),
    conversation: frame.conversation ?? "c-" + digest(requestId).slice(0, 8), detail: "Remote queue accepted the message. Receipt " + handle };
}

export async function sendStatus(handle, { directory = loadDirectory, query = requestHost } = {}) {
  let address;
  try { address = parseAddress(handle); } catch { return failed("invalid_handle"); }
  if (!address.host || !matches(UUID, address.id) || address.id[14] !== "7") return failed("invalid_handle");
  let fleet;
  try { fleet = directory(); } catch { return failed("directory_unavailable"); }
  const entry = fleet.hosts.find(row => row.host === address.host);
  if (!entry || address.host === fleet.local) return failed("invalid_handle");
  const { state, error } = await exchange(entry, fleet.local, { v: 2, op: "status", host: address.host, requestId: address.id }, query);
  if (error) return failed(error, { handle });
  return { ok: state === "queued", handle, state, delivery: "not_proven", detail: "Dispatch receipt: " + state };
}
