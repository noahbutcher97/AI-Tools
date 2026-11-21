import { createBoundDelivery } from "./bound-delivery.mjs";
import { sendMessage } from "./client.mjs";
import { permitsLocalProof, resolveLocalAddress } from "./local-address.mjs";
import { localPing, localStatus, pingBound as probe } from "./local-ping.mjs";

function refused(result) {
  return { ok: false, state: result.state, cause: result.state, detail: result.detail, dispatch: "not_submitted" };
}

function sameTarget(left, right) {
  return left.host === right.host && left.adapter === right.adapter && left.id === right.id;
}

// Legacy Claude sends accept a display name and still enforce their original
// opt-in, unique delivery name and live instance checks in sendMessage.
function legacyGuard(resolve, selector, initial) {
  let pinned = initial.target;
  const changed = { cause: "binding_changed", detail: "Local session binding changed. Resolve the address again." };
  return async target => {
    let current = await resolve(selector);
    if (!initial.ok) {
      // A legacy alias must stay free of conflicting exact raw IDs.
      if (current.ok || current.state !== "missing" || target.name !== selector.id) return changed;
      current = await resolve({ ...selector, id: target.id });
    }
    if (!current.ok) return { cause: current.state, detail: current.detail };
    const binding = current.target;
    if (binding.id !== target.id || binding.adapter !== target.kind || (pinned && !sameTarget(pinned, binding))) return changed;
    pinned = binding;
    return null;
  };
}

// The installation chooses these functions. Public requests supply a selector
// and message fields only. Status uses the same proof readers in a fresh process.
export function createInstalledDelivery({ resolve = resolveLocalAddress, checkProofBinding = permitsLocalProof, adapters = [],
  sendLegacy = sendMessage, pingLegacy = localPing } = {}) {
  const sendBound = createBoundDelivery({ resolve, adapters });
  const proofAdapters = new Map(adapters.filter(adapter => adapter.proof).map(adapter => [adapter.kind, adapter.proof]));
  const pingBound = (selector, options = {}) => probe(selector, { ...options, sendBound, proofAdapters, checkProofBinding });
  const status = handle => localStatus(handle, { proofAdapters, checkProofBinding });

  async function sendLocal(options, host) {
    const selector = { id: options.to, ...(host && { host }) };
    const initial = await resolve(selector);
    if (initial.ok && initial.target.adapter !== "claude") {
      return sendBound(selector, { ...options, expectedBinding: initial.target });
    }
    if (!initial.ok && initial.state !== "missing") return refused(initial);
    return sendLegacy({ ...options, checkLocalBinding: legacyGuard(resolve, selector, initial) });
  }

  async function pingLocal(id, options, host) {
    const selector = { id, ...(host && { host }) };
    const initial = await resolve(selector);
    if (!initial.ok) return refused(initial);
    if (initial.target.adapter === "claude") {
      return pingLegacy(id, { ...options, checkLocalBinding: legacyGuard(resolve, selector, initial) });
    }
    return pingBound(selector, { ...options, expectedBinding: initial.target });
  }

  return { sendBound, pingBound, status, sendLocal, pingLocal };
}

export const { sendBound, pingBound, status: localReceiptStatus, sendLocal, pingLocal } = createInstalledDelivery();
