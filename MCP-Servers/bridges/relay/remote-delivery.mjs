import { runProvider } from "./provider-process.mjs";
import { randomUUID } from "node:crypto";
import { captureCursor, prove } from "./proof.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexQueueBlock, resolveCodexReference, SEND_CAUSES } from "./client.mjs";
import { installationRoot, surveyRemoteSelection } from "./fleet.mjs";
import { createLocalAddresses } from "./local-address.mjs";
import { digest, UUID, matches, remoteEnvelope, requestDigest } from "./delivery-protocol.mjs";
import { readEnabledReceivePolicy } from "./receive-policy.mjs";
import { openReceipts } from "./receipts.mjs";

const resolveRemoteRecipient = createLocalAddresses({ survey: surveyRemoteSelection }).resolve;

function policyAllows(peer, id) {
  const policy = readEnabledReceivePolicy();
  return policy?.codex.some(row => row.peer === peer && (id === null || row.ids === "all" || row.ids.includes(id))) ?? false;
}

function providerPath() {
  const binary = path.join(installationRoot(), "provider", process.platform === "win32" ? "codex.exe" : "codex");
  const resolved = fs.realpathSync.native(binary);
  if (path.relative(binary, resolved) !== "" || !fs.statSync(binary).isFile()) throw new Error("provider_unavailable");
  fs.accessSync(binary, fs.constants.X_OK);
  return binary;
}

async function queue(id, text) {
  const binary = providerPath();
  const windows = process.platform === "win32";
  const profile = os.homedir();
  const env = { HOME: profile, CODEX_HOME: path.join(profile, ".codex") };
  if (windows) Object.assign(env, { USERPROFILE: profile, SystemRoot: process.env.SystemRoot,
    PATH: path.join(process.env.SystemRoot, "System32") });
  const output = await runProvider(binary, ["queue", "--thread", id, "--message", text], {
    cwd: path.dirname(binary), env, maxBytes: 8192,
  });
  const receipt = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.?$/i.exec(output.stdout.trim());
  return output.code === 0 && receipt && matches(UUID, receipt[1]) && receipt[2] === id ? "queued" : "unknown";
}

export async function dispatchRemote(request, peer, {
  allowed = policyAllows, resolve = resolveRemoteRecipient, check = codexQueueBlock, reference = resolveCodexReference,
  available = providerPath, run = queue, receipts = () => openReceipts(path.join(installationRoot(), "receipts.sqlite")),
  now = Date.now, capture = captureCursor, verify = prove,
} = {}) {
  const id = request.to ?? null;
  if (allowed(peer, id) !== true) return "receive_denied";
  let store;
  let reserved = false;
  let hash;
  try {
    async function current(state) {
      if (state !== "pending" && state !== "unknown") return state;
      const proof = store.proof(peer, request.requestId);
      if (!proof) return state;
      if (allowed(peer, proof.cursor.id) !== true) return "receive_denied";
      return verify(proof.cursor, proof.expected);
    }
    if (request.op === "status") {
      store = await receipts();
      return await current(store.status(peer, request.requestId));
    }
    if (request.op === "send" || request.op === "ping") {
      store = await receipts();
      hash = requestDigest(request);
      const state = store.reserve(peer, request.requestId, hash, now());
      if (state !== "reserved") return await current(state);
      reserved = true;
    }
    function finish(state) {
      if (reserved) store.finish(peer, request.requestId, hash, state);
      return state;
    }
    // receive() matched request.host to the forced receiver's host label.
    // Version 2 has no adapter field, so every lookup must remain unqualified.
    async function selectionRefusal() {
      const result = await resolve({ host: request.host, id }, { requireCodexEligibility: true });
      if (!result?.ok) return result?.state === SEND_CAUSES.NOT_ADDRESSABLE ? "unaddressable" : "unresolved";
      if (result.target?.host !== request.host || result.target?.id !== id) return "unresolved";
      if (result.target.adapter !== "codex") return "restricted_route";
      return matches(UUID, id) ? null : "unaddressable";
    }
    const first = await selectionRefusal();
    if (first) return finish(first);
    try { available(); } catch { return finish("provider_unavailable"); }
    async function queueRefusal() {
      // The queue store can take time to open. Re-survey after opening it,
      // then let the native barrier sample the current backlog and writer lock.
      let selection = "unresolved";
      const blocked = await check(id, { checkBinding: async () => {
        selection = await selectionRefusal();
        return selection;
      } });
      return selection ?? (blocked ? "unaddressable" : null);
    }
    const ping = request.op === "ping";
    if (request.re || ping || request.op === "resolve") {
      const blocked = await queueRefusal();
      if (blocked) return finish(blocked);
      if (allowed(peer, id) !== true) return finish("receive_denied");
      if (request.op === "resolve") return "eligible";
    }
    let quote = null;
    if (request.re) {
      quote = await reference(id, request.re);
      if (!quote.ok) return finish("reference_unresolved");
    }
    const payload = ping ? { ...request, kind: "notice", from: null, inReplyTo: null,
      message: "Delivery probe " + randomUUID() + ". No reply is needed." } : request;
    const text = remoteEnvelope(payload, peer, quote);
    // Windows quoting can double every character in the worst case. Leave room for the image path and fixed argv.
    if (text.length * 2 + 1024 > 32767) return finish("message_too_large");
    if (ping) {
      let cursor;
      try { cursor = await capture({ kind: "codex", id }); } catch { return finish("proof_unavailable"); }
      if (cursor?.kind !== "codex" || cursor.id !== id) return finish("proof_unavailable");
      store.saveProof(peer, request.requestId, cursor, digest(text));
    }
    const blocked = await queueRefusal();
    if (blocked) return finish(blocked);
    if (allowed(peer, id) !== true) return finish("receive_denied");
    const outcome = await run(id, text);
    if (ping && outcome === "queued") return await current(finish("pending"));
    return finish(outcome);
  } catch { return reserved ? "unknown" : "unavailable"; }
  finally { store?.close(); }
}
