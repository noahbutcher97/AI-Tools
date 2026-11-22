import { localHostLabel } from "./local-address.mjs";
import { pingBound, sendBound } from "./installed-delivery.mjs";
import { loadDirectory, requestHost, INVENTORY_SURVEY_MS } from "./fleet.mjs";
import { resolveAddress } from "./resolve-address.mjs";
import { digest, exactKeys, matches, newRequestId, UUID } from "./delivery-protocol.mjs";
import { validBoundEffectFrame, validBoundEffectState } from "./effect-protocol.mjs";

const prefix = "remote-proof.";
const deadlines = { resolve: 5000 + 2 * INVENTORY_SURVEY_MS, send: 45000, ping: 45000, status: 5000 };
const successStates = { eligible: ["resolve"], queued: ["send", "status"], pending: ["ping", "status"], delivered: ["ping", "status"] };
const details = {
  effect_refused: "The receiver refused version 4 eligibility. Check its relay version. No message body was sent.",
  receive_denied: "The receiver denied this operation. Check the peer, adapter, literal ID and operation in its installed grants.",
  restricted_route: "The receiver has no qualified route for this adapter and operation.",
  request_conflict: "This request ID already belongs to a different request. Check the original receipt.",
  invalid_request_id: "A remote request ID must be a version 7 UUID.",
};

function failed(cause, extra = {}) {
  return { ok: false, state: cause, cause, detail: details[cause] ?? cause.replaceAll("_", " "), ...extra };
}

function makeHandle({ host, adapter, to, requestId }) {
  return prefix + Buffer.from(JSON.stringify([host, adapter, to, requestId])).toString("base64url");
}

function statusFrame(handle) {
  if (typeof handle !== "string" || !handle.startsWith(prefix) || handle.length > 4096) return null;
  try {
    const tuple = JSON.parse(Buffer.from(handle.slice(prefix.length), "base64url").toString("utf8"));
    if (!Array.isArray(tuple) || tuple.length !== 4) return null;
    const [host, adapter, to, requestId] = tuple;
    const frame = { v: 4, op: "status", requestId, host, to, adapter };
    return validBoundEffectFrame(frame) && makeHandle(frame) === handle ? frame : null;
  } catch { return null; }
}

async function exchange(entry, peer, frame) {
  try {
    const { reply, error } = await requestHost(entry, frame, deadlines[frame.op]);
    if (error) return { error };
    if (!exactKeys(reply, ["ok", "v", "op", "requestId", "host", "peer", "state", "to", "adapter"]) ||
        reply.ok !== true || reply.v !== frame.v || reply.op !== frame.op || reply.requestId !== frame.requestId ||
        reply.host !== frame.host || reply.peer !== peer || reply.to !== frame.to || reply.adapter !== frame.adapter ||
        !validBoundEffectState(reply.state) ||
        (Object.hasOwn(successStates, reply.state) && !successStates[reply.state].includes(frame.op))) {
      return { error: "invalid_response" };
    }
    return { state: reply.state };
  } catch { return { error: "transport_unavailable" }; }
}

function route(host) {
  let fleet;
  try { fleet = loadDirectory(); } catch { return failed("directory_unavailable"); }
  if (fleet.local === host) return failed("installation_changed");
  const entry = fleet.hosts.find(item => item.host === host);
  return entry ? { ok: true, entry, peer: fleet.local } : failed("unknown_host");
}

export async function boundRemoteStatus(handle) {
  const frame = statusFrame(handle);
  if (!frame) return failed("invalid_handle");
  const destination = route(frame.host);
  if (!destination.ok) return { ...destination, handle };
  const { state, error } = await exchange(destination.entry, destination.peer, frame);
  if (error) return failed(error, { handle });
  return { ok: state === "queued" || state === "delivered", handle, state,
    delivery: state === "delivered" ? "delivered" : "not_proven", detail: "Receipt: " + state };
}

export async function addressedEffect(action, selector, options = {}) {
  const { host } = selector;
  if (host !== undefined) {
    let local;
    try { local = localHostLabel(); } catch { return failed("host_unavailable"); }
    if (!local) return failed("host_unavailable");
    if (local !== host) return remoteEffect(action, selector, options);
  }
  if (options.requestId !== undefined) return failed("request_id_requires_remote_host");
  return action === "ping" ? pingBound(selector, options) : sendBound(selector, options);
}

async function remoteEffect(action, selector, options) {
  const { host, id: to } = selector;
  let { adapter } = selector;
  const requestId = options.requestId ?? newRequestId();
  if (!matches(UUID, requestId) || requestId[14] !== "7") return failed("invalid_request_id");
  if (adapter === undefined) {
    const result = await resolveAddress(selector);
    if (!result.ok) return { ...result, cause: result.state,
      ...(options.requestId === undefined ? { dispatch: "not_submitted" } :
        { detail: result.detail + " This attempt sent no body. Check the receipt from the original attempt." }) };
    if (result.target.host !== host || result.target.id !== to) return failed("installation_changed");
    adapter = result.target.adapter;
  }
  const common = { v: 4, host, to, adapter, requestId };
  const frame = action === "ping" ? { ...common, op: action } : { ...common, op: action,
    message: options.message, kind: options.kind ?? "notice", from: options.identity?.id ?? options.origin ?? null,
    conversation: options.conversation ?? null, inReplyTo: options.inReplyTo ?? null, re: options.re ?? null };
  if (!validBoundEffectFrame(frame)) return failed("invalid_effect_fields");
  const handle = makeHandle(frame);
  const destination = route(host);
  const prior = options.requestId !== undefined && !options.dryRun ? { handle } : {};
  if (!destination.ok) return { ...destination, ...prior };
  const { entry, peer } = destination;
  const lookup = await exchange(entry, peer, { ...common, op: "resolve", action });
  if (lookup.state !== "eligible") {
    const result = failed(lookup.error ?? lookup.state, prior);
    if (prior.handle) result.detail += " This attempt sent no body. Check an earlier attempt with its original receipt.";
    else result.dispatch = "not_submitted";
    return result;
  }
  const target = { host, adapter, id: to };
  if (options.dryRun) return { ok: true, state: "eligible", target, detail: "The selected remote recipient is eligible." };
  options.onHandle?.(handle);
  const response = await exchange(entry, peer, frame);
  if (response.error || response.state === "unknown") return failed("unknown", { handle,
    detail: "Submission outcome unknown. Check without resending: relay ping --status " + handle });
  if (action === "ping") {
    let state = response.state;
    if (state === "pending") {
      const status = await boundRemoteStatus(handle);
      state = status.state === "delivered" ? "delivered" : status.state === "pending" ? "pending" : "unknown";
    }
    const detail = ["pending", "unknown"].includes(state) ? "Check without resending: relay ping --status " + handle : "Delivery probe: " + state;
    return { ok: state === "delivered", state, handle, target, detail };
  }
  if (response.state !== "queued") return failed(response.state, { handle });
  return { ok: true, state: "queued", handle, target, messageId: "m-" + requestId.replaceAll("-", ""),
    conversation: frame.conversation ?? "c-" + digest(requestId).slice(0, 8), detail: "Remote adapter accepted the notice. Receipt " + handle };
}
