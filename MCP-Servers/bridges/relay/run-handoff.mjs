import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverTargets } from "./client.mjs";
import { statusBinding } from "./completion-jobs.mjs";
import { digest, exactKeys, matches, UUID } from "./delivery-protocol.mjs";
import { installationRoot } from "./fleet.mjs";

const HEX = /^[a-f0-9]{64}$/;
const MAX_BYTES = 4096;

export function validRunGrant(value) {
  return exactKeys(value, ["id", "capability"]) && matches(UUID, value.id) && matches(HEX, value.capability);
}

function handoffPath(root, binding) {
  if (!matches(HEX, binding) || !path.isAbsolute(root)) throw new Error("invalid grant location");
  const dir = path.join(root, "completion-grants");
  if (path.relative(dir, fs.realpathSync.native(dir)) !== "") throw new Error("redirected grant directory");
  return path.join(dir, binding + ".json");
}

function readBatch(file) {
  if (path.relative(file, fs.realpathSync.native(file)) !== "") throw new Error("redirected grant file");
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("invalid grant file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const n = fs.readSync(fd, bytes);
    if (n !== stat.size) throw new Error("invalid grant file");
    return bytes.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

function parseBatch(bytes, binding) {
  const batch = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!exactKeys(batch, ["v", "session", "instance", "validUntil", "grants"]) || batch.v !== 1 ||
      batch.instance !== binding || !matches(UUID, batch.session) || !Number.isSafeInteger(batch.validUntil) ||
      !Array.isArray(batch.grants) || batch.grants.length < 1 || batch.grants.length > 8 ||
      !batch.grants.every(validRunGrant) || new Set(batch.grants.map(g => g.id)).size !== batch.grants.length) {
    throw new Error("invalid grant handoff");
  }
  return batch;
}

// Only the separate broker writes this directory. Link a complete new file
// without replacing an existing publication, including after a broker crash.
export function publishRunHandoff(root, binding, hash, pending) {
  const file = handoffPath(root, binding);
  function verify() {
    if (digest(readBatch(file)) !== hash) throw new Error("grant handoff changed");
  }
  try { verify(); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (typeof pending !== "string" || Buffer.byteLength(pending) > MAX_BYTES || digest(pending) !== hash) {
    throw new Error("grant handoff unavailable");
  }
  parseBatch(Buffer.from(pending), binding);
  const temp = path.join(path.dirname(file), randomUUID() + ".tmp");
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, pending);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, file); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    verify();
  } finally { fs.unlinkSync(temp); }
}

export async function availableGrant(session, report, { root = installationRoot(), discover = discoverTargets,
  now = Date.now, port, provider = "claude" } = {}) {
  const { targets } = await discover({ scope: "all" });
  const matching = targets.filter(target => target.id === session);
  if (matching.length !== 1) throw new Error("ambiguous or absent session");
  const target = matching[0];
  if (target.kind !== provider) throw new Error("provider mismatch");
  const binding = statusBinding(target);
  if (provider === "claude") process.kill(target.pid, 0);
  const batch = parseBatch(readBatch(handoffPath(root, binding)), binding);
  if (batch.session !== session || batch.validUntil <= now()) throw new Error("grant handoff expired or mismatched");
  const event = provider === "claude" ? { session } : { session, provider };
  const checks = await Promise.allSettled(batch.grants.map(grant => report(grant, "available_run", event, { port })));
  const index = checks.findIndex(check => check.status === "fulfilled");
  if (index < 0) throw new Error("no unused run grant");
  return batch.grants[index];
}
