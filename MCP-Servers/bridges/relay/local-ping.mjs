import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendMessage } from "./client.mjs";
import { digest, exactKeys, HOST, matches, UUID } from "./delivery-protocol.mjs";
import { captureCursor, prove } from "./proof.mjs";
import { runProvider } from "./provider-process.mjs";

const PREFIX = "local-proof.";
const MAX_HANDLE = 8192;
const codexProof = {
  validateId: id => matches(UUID, id),
  capture: (binding, options) => captureCursor({ kind: "codex", id: binding.id }, options),
  verify: prove,
};

// Additional readers are supplied by trusted installation code. The authenticated
// binding selects the reader on recovery, independently of current discovery.
async function proofReader(binding, proofAdapters, checkProofBinding) {
  if (!exactKeys(binding, ["host", "adapter", "id"]) ||
      (binding.host !== null && !matches(HOST, binding.host)) || !matches(HOST, binding.adapter) ||
      typeof binding.id !== "string" || !binding.id.length || binding.id.length > 256 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(binding.id)) throw new Error("invalid proof binding");
  if (checkProofBinding && await checkProofBinding(binding) !== true) throw new Error("proof binding unavailable");
  const reader = binding.adapter === "codex" ? codexProof : proofAdapters?.get(binding.adapter);
  if (typeof reader?.verify !== "function" ||
      reader.validateId?.(binding.id) !== true) throw new Error("proof unavailable");
  return reader;
}

function matchesCursor(binding, cursor) {
  return cursor?.kind === binding.adapter && cursor.id === binding.id &&
    (!Object.hasOwn(cursor, "host") || cursor.host === binding.host) &&
    (!Object.hasOwn(cursor, "adapter") || cursor.adapter === binding.adapter);
}

function unavailable() {
  return { ok: false, state: "proof_unavailable", detail: "Invalid or unavailable local proof handle." };
}

function localKey(profile, create) {
  const root = path.join(profile, ".cross-agent-relay");
  const file = path.join(root, "proof.key");
  if (create) fs.mkdirSync(root, { mode: 0o700, recursive: true });
  if (path.relative(root, fs.realpathSync.native(root)) !== "") throw new Error("invalid proof directory");
  if (create && !fs.existsSync(file)) {
    const temporary = path.join(root, randomUUID() + ".tmp");
    fs.writeFileSync(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
    try { fs.linkSync(temporary, file); } catch (err) { if (err.code !== "EEXIST") throw err; }
    finally { fs.unlinkSync(temporary); }
  }
  if (path.relative(file, fs.realpathSync.native(file)) !== "" || fs.statSync(file).size !== 32) throw new Error("invalid proof key");
  return fs.readFileSync(file);
}

function seal(record, profile) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKey(profile, true), iv);
  cipher.setAAD(Buffer.from(PREFIX));
  const text = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), text]).toString("base64url");
}

export async function localStatus(handle, { profile = os.homedir(), verify = prove, proofAdapters, checkProofBinding } = {}) {
  let record;
  try {
    if (typeof handle !== "string" || !handle.startsWith(PREFIX) || handle.length > MAX_HANDLE) throw new Error();
    const encoded = handle.slice(PREFIX.length);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length < 29 || bytes.toString("base64url") !== encoded) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", localKey(profile, false), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(PREFIX));
    decipher.setAuthTag(bytes.subarray(12, 28));
    record = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    if (!matches(/^[0-9a-f]{64}$/, record.expected)) return unavailable();
    let state;
    if (exactKeys(record, ["cursor", "expected"])) {
      state = await verify(record.cursor, record.expected, { profile });
    } else {
      if (record.v !== 2 || !exactKeys(record, ["v", "binding", "cursor", "expected"])) return unavailable();
      const reader = await proofReader(record.binding, proofAdapters, checkProofBinding);
      if (!matchesCursor(record.binding, record.cursor)) return unavailable();
      state = await reader.verify(record.cursor, record.expected, { profile, binding: record.binding });
    }
    if (!["pending", "delivered", "proof_unavailable"].includes(state)) state = "proof_unavailable";
    return { ok: state === "delivered", state, handle, to: record.cursor.id, ...(record.v === 2 && { binding: record.binding }),
      checkedAt: new Date().toISOString(), detail: "Transcript proof: " + state };
  } catch { return unavailable(); }
}

function probeMessage() { return "Delivery probe " + randomUUID() + ". No reply is needed."; }

export function localPing(to, options) {
  return sendProvedNotice(to, probeMessage(), options);
}

async function pollStatus(handle, options, waitMs) {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const status = await localStatus(handle, options);
    if (status.state !== "pending" || performance.now() >= deadline) return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// The installation supplies the same bound sender and proof readers used by
// its public send path. The broker package needs only the native proof path.
export async function pingBound(selector, { sendBound: send, proofAdapters, expectedBinding,
  checkProofBinding, profile = os.homedir(), waitMs = 2000, onHandle = () => {} } = {}) {
  let handle, captureFailed = false, result;
  try {
    result = await send(selector, { expectedBinding, kind: "notice", message: probeMessage(), beforeSubmit: async (binding, text) => {
      captureFailed = true;
      if (binding.id !== selector.id || (selector.adapter !== undefined && binding.adapter !== selector.adapter) ||
          (selector.host !== undefined && binding.host !== selector.host)) throw new Error("proof binding changed");
      const reader = await proofReader(binding, proofAdapters, checkProofBinding);
      if (typeof text !== "string" || typeof reader.capture !== "function") throw new Error("proof capture unavailable");
      const captured = await reader.capture(binding, { profile });
      const cursor = JSON.parse(JSON.stringify(captured));
      if (!matchesCursor(binding, cursor)) throw new Error("proof cursor changed");
      const reserved = seal({ v: 2, binding, cursor, expected: digest(text) }, profile);
      if (reserved.length > MAX_HANDLE) throw new Error("proof cursor too large");
      await onHandle(reserved, binding);
      handle = reserved;
      captureFailed = false;
    } });
  } catch { /* A lost acknowledgement after reservation leaves a checkable handle. */ }
  if (captureFailed) return { ok: false, state: "dispatch_failed", dispatch: "not_submitted", cause: "proof_unavailable",
    detail: "Could not reserve transcript proof for this recipient. No probe was submitted." };
  if (result?.dispatch === "not_submitted") return { ...result, state: "dispatch_failed" };
  if (!handle) return { ok: false, state: "dispatch_failed", dispatch: "not_submitted", cause: "proof_unavailable",
    detail: "Could not prepare the delivery probe." };
  const status = await pollStatus(handle, { profile, proofAdapters, checkProofBinding }, waitMs);
  return { ...status, handle, dispatch: result?.ok ? "accepted" : "unknown" };
}

// The caller supplies the notice and can durably reserve its handle before
// submission. Recovery uses localStatus(handle), which never calls a provider.
export async function sendProvedNotice(to, message, { allowDelegate = false, profile = os.homedir(), send = sendMessage,
  capture = captureCursor, verify = prove, onHandle = () => {}, checkTarget = () => {}, checkLocalBinding, deferProof = false, waitMs = 2000, signal,
  runDelegate, runQueue } = {}) {
  if (!matches(UUID, to)) return { ok: false, cause: "invalid_target", detail: "A proved notice requires a raw session ID." };
  if (typeof message !== "string" || !message.trim()) return { ok: false, cause: "empty_notice", detail: "A proved notice needs a body." };
  let handle;
  const result = await send({
    to, exactId: true, scope: "all", allowDelegate, kind: "notice", message, runQueue, checkLocalBinding,
    beforeSubmit: async (target, text) => {
      if (target.id !== to) throw new Error("target changed");
      await checkTarget(target);
      const cursor = await capture(target, { profile });
      const reserved = seal({ cursor, expected: digest(text) }, profile);
      await onHandle(reserved, target);
      handle = reserved;
    },
    runDelegate: runDelegate ?? (invocation => runProvider(invocation.command, ["--model", "haiku", "--effort", "low", ...invocation.args],
      { stdin: invocation.stdin, signal })),
  });
  if (result.dispatch === "not_submitted") return { ...result, state: "dispatch_failed" };
  if (!handle) return { ok: false, state: "dispatch_failed", cause: result.cause ?? "proof_unavailable",
    detail: "Notice could not start. Check the recipient, transcript and receipt storage." };
  if (deferProof) return { ok: false, state: "pending", to, handle, dispatch: result.ok ? "accepted" : "unknown" };
  return { ...await pollStatus(handle, { profile, verify }, waitMs), dispatch: result.ok ? "accepted" : "unknown" };
}
