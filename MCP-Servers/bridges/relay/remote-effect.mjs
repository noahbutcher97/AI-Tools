import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasLocalDeliveryRoute, SEND_CAUSES } from "./client.mjs";
import { digest, exactKeys, HOST, matches, remoteEnvelope, requestDigest, UUID } from "./delivery-protocol.mjs";
import { validBoundEffectFrame } from "./effect-protocol.mjs";
import { installationRoot } from "./fleet.mjs";
import { installedReaders } from "./installed-readers.mjs";
import { permitsLocalProof } from "./local-address.mjs";
import { validLookupId } from "./lookup-protocol.mjs";
import { readEnabledReceivePolicy } from "./receive-policy.mjs";

const actions = ["send", "ping", "status"];
export function effectAllowed(peer, binding, action, root = installationRoot()) {
  try {
    if (!readEnabledReceivePolicy(root)) return false;
    const policy = JSON.parse(fs.readFileSync(path.join(root, "effect-policy.json"), "utf8"));
    return exactKeys(policy, ["v", "grants"]) && policy.v === 1 && Array.isArray(policy.grants) &&
      policy.grants.every(g => exactKeys(g, ["peer", "adapter", "ids", "ops"]) && matches(HOST, g.peer) &&
        matches(HOST, g.adapter) && Array.isArray(g.ids) && g.ids.every(validLookupId) &&
        Array.isArray(g.ops) && g.ops.every(op => actions.includes(op))) &&
      policy.grants.some(g => g.peer === peer && g.adapter === binding.adapter &&
        g.ids.includes(binding.id) && g.ops.includes(action));
  } catch { return false; }
}

function storedBinding(binding, op) {
  return JSON.stringify([binding.host, binding.adapter, binding.id, op]);
}

function validCursor(cursor, binding) {
  return cursor?.kind === binding.adapter && cursor.id === binding.id &&
    (!Object.hasOwn(cursor, "host") || cursor.host === binding.host) &&
    (!Object.hasOwn(cursor, "adapter") || cursor.adapter === binding.adapter);
}

export async function dispatchBoundRemote(request, peer, options) {
  if (!validBoundEffectFrame(request) || !matches(HOST, peer) || request.host === peer) return "receive_denied";
  const { resolve, check, reference, available, run, receipts, now, capture, verify,
    adapters = installedReaders, permit = effectAllowed, permitsProof = permitsLocalProof } = options;
  const binding = Object.freeze({ host: request.host, adapter: request.adapter, id: request.to });
  const action = request.op === "resolve" ? request.action : request.op;
  const permitted = () => permit(peer, binding, action) === true;
  if (!permitted()) return "receive_denied";
  const native = binding.adapter === "codex";
  const matchesKind = adapters.filter(reader => reader.kind === binding.adapter);
  const route = !native && binding.adapter !== "claude" && matchesKind.length === 1 ? matchesKind[0] : null;
  const proof = native ? {
    validateId: id => matches(UUID, id), capture: () => capture({ kind: "codex", id: binding.id }), verify,
  } : route?.proof;
  let store, reserved = false;
  const hash = requestDigest(request);
  const key = request.requestId;
  const stored = op => storedBinding(binding, op);
  const proofReady = () => permitsProof(binding) === true && proof?.validateId?.(binding.id) === true &&
    typeof proof.verify === "function";

  async function checkedState(state) {
    if (!["pending", "unknown"].includes(state)) return state;
    const saved = store.proof(peer, key);
    if (!saved) return state;
    if (!permitted()) return "receive_denied";
    if (!proofReady() || !validCursor(saved.cursor, binding) || !matches(/^[0-9a-f]{64}$/, saved.expected)) return "proof_unavailable";
    const result = await proof.verify(saved.cursor, saved.expected, { binding, profile: os.homedir() });
    if (!permitted()) return "receive_denied";
    if (state === "unknown" && result === "pending") return "unknown";
    return ["pending", "delivered"].includes(result) ? result : "proof_unavailable";
  }

  async function status() {
    const row = store.record(peer, key);
    if (!row) return "missing";
    if (row.binding === stored("send")) return row.state;
    if (row.binding !== stored("ping")) {
      // A legacy probe has a recomputable digest and a pinned cursor. A
      // legacy ordinary send has no independently checkable recipient.
      const legacy = { v: 2, op: "ping", host: binding.host, to: binding.id };
      if (row.binding !== null || !native || row.digest !== requestDigest(legacy) ||
          !validCursor(store.proof(peer, key)?.cursor, binding)) return "missing";
    }
    return checkedState(row.state);
  }

  async function selection() {
    if (!permitted()) return "receive_denied";
    const current = await resolve(binding, { requireCodexEligibility: native });
    if (!permitted()) return "receive_denied";
    if (!current?.ok) return current?.state === SEND_CAUSES.NOT_ADDRESSABLE ? "unaddressable" : "unresolved";
    return current.target?.host === binding.host && current.target.id === binding.id &&
      current.target.adapter === binding.adapter ? null : "unresolved";
  }

  async function readiness() {
    if (!permitted()) return "receive_denied";
    if (native) {
      let refusal = "unresolved";
      const blocked = await check(binding.id, { checkBinding: async () => { refusal = await selection(); return refusal; } });
      return refusal ?? (blocked ? "unaddressable" : null);
    }
    if (await route.ready(binding) !== true) return "unaddressable";
    return selection();
  }

  function finish(state) {
    if (reserved) store.finish(peer, key, hash, state);
    return permitted() ? state : "receive_denied";
  }

  try {
    store = await receipts();
    if (!permitted()) return "receive_denied";
    if (action === "status") return await status();
    const immutable = stored(action);
    if (request.op === "resolve") {
      const row = store.record(peer, key);
      if (row) return row.binding === immutable ? "eligible" : "request_conflict";
      if (!store.supportsBindings) return "unavailable";
    } else {
      const state = store.reserve(peer, key, hash, now(), immutable);
      if (state !== "reserved") return action === "ping" ? await checkedState(state) : state;
      reserved = true;
    }
    if (native) {
      if (!matches(UUID, binding.id)) return finish("unaddressable");
      try { available(); } catch { return finish("provider_unavailable"); }
    } else if (!route || !hasLocalDeliveryRoute(route) || route.validId(binding.id) !== true) {
      return finish("restricted_route");
    }
    if (action === "ping" && (!proofReady() || typeof proof.capture !== "function")) return finish("proof_unavailable");
    const selected = await selection();
    if (selected) return finish(selected);
    const first = await readiness();
    if (first || !permitted()) return finish(first ?? "receive_denied");
    if (request.op === "resolve") return "eligible";
    let quote;
    if (request.re) {
      if (!native) return finish("reference_unresolved");
      quote = await reference(binding.id, request.re);
      if (quote?.ok !== true) return finish("reference_unresolved");
    }
    const ping = action === "ping";
    const payload = ping ? { ...request, kind: "notice", from: null, inReplyTo: null,
      message: "Delivery probe " + randomUUID() + ". No reply is needed." } : request;
    const text = remoteEnvelope(payload, peer, quote);
    if (native && text.length * 2 + 1024 > 32767) return finish("message_too_large");
    if (ping) {
      let cursor;
      try {
        if (!permitted() || !proofReady()) return finish("receive_denied");
        const encoded = JSON.stringify(await proof.capture(binding, { binding, profile: os.homedir() }));
        if (Buffer.byteLength(encoded) > 8192) return finish("proof_unavailable");
        cursor = JSON.parse(encoded);
      } catch { return finish("proof_unavailable"); }
      if (!validCursor(cursor, binding)) return finish("proof_unavailable");
      if (!permitted()) return finish("receive_denied");
      store.saveProof(peer, key, cursor, digest(text));
    }
    const last = await readiness();
    if (last || !permitted()) return finish(last ?? "receive_denied");
    const accepted = native ? await run(binding.id, text) === "queued" : (await route.submit(binding, text))?.ok === true;
    if (!accepted) return finish("unknown");
    return ping ? await checkedState(finish("pending")) : finish("queued");
  } catch { return permitted() ? (reserved ? "unknown" : "unavailable") : "receive_denied"; }
  finally { store?.close(); }
}
