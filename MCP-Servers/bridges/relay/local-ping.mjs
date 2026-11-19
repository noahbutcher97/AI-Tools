import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendMessage } from "./client.mjs";
import { digest, matches, UUID } from "./delivery-protocol.mjs";
import { captureCursor, prove } from "./proof.mjs";
import { runProvider } from "./provider-process.mjs";

const PREFIX = "local-proof.";
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

export async function localStatus(handle, { profile = os.homedir(), verify = prove } = {}) {
  let record;
  try {
    if (typeof handle !== "string" || !handle.startsWith(PREFIX) || handle.length > 8192) throw new Error();
    const encoded = handle.slice(PREFIX.length);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length < 29 || bytes.toString("base64url") !== encoded) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", localKey(profile, false), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(PREFIX));
    decipher.setAuthTag(bytes.subarray(12, 28));
    record = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  } catch { return { ok: false, state: "proof_unavailable", detail: "Invalid or unavailable local proof handle." }; }
  const state = await verify(record.cursor, record.expected, { profile });
  return { ok: state === "delivered", state, handle, to: record.cursor.id, checkedAt: new Date().toISOString(),
    detail: "Transcript proof: " + state };
}

export function localPing(to, options) {
  return sendProvedNotice(to, "Delivery probe " + randomUUID() + ". No reply is needed.", options);
}

// The caller supplies the notice and can durably reserve its handle before
// submission. Recovery uses localStatus(handle), which never calls a provider.
export async function sendProvedNotice(to, message, { allowDelegate = false, profile = os.homedir(), send = sendMessage,
  capture = captureCursor, verify = prove, onHandle = () => {}, checkTarget = () => {}, deferProof = false, waitMs = 2000, signal,
  runDelegate } = {}) {
  if (!matches(UUID, to)) return { ok: false, cause: "invalid_target", detail: "A proved notice requires a raw session ID." };
  if (typeof message !== "string" || !message.trim()) return { ok: false, cause: "empty_notice", detail: "A proved notice needs a body." };
  let handle;
  const result = await send({
    to, exactId: true, scope: "all", allowDelegate, kind: "notice", message,
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
  if (!handle) return { ok: false, state: "dispatch_failed", cause: result.cause ?? "proof_unavailable",
    detail: "Notice could not start. Check the recipient, transcript and receipt storage." };
  if (deferProof) return { ok: false, state: "pending", to, handle, dispatch: result.ok ? "accepted" : "unknown" };
  const deadline = performance.now() + waitMs;
  let status;
  do {
    status = await localStatus(handle, { profile, verify });
    if (status.state !== "pending" || performance.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (true);
  return { ...status, dispatch: result.ok ? "accepted" : "unknown" };
}
