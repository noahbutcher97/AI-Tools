import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matches, UUID, digest } from "./delivery-protocol.mjs";
import { encodeProjectDir } from "./client.mjs";

const MAX_INPUT = 2 * 1024 * 1024;
const MAX_ITEMS = 256;

// Pin both the canonical path and file instance. Never follow an indexed path or a link outside the provider root.
function pinnedFile(root, relative) {
  const file = path.join(root, relative);
  if (!path.isAbsolute(root) || path.relative(file, fs.realpathSync.native(file)) !== "") throw new Error("unexpected file");
  const st = fs.statSync(file, { bigint: true });
  if (!st.isFile()) throw new Error("unexpected file type");
  return { file, instance: digest([st.dev, st.ino, st.birthtimeNs].join("/")), size: Number(st.size) };
}

async function readCodex(root, id, cursor, expected) {
  const file = pinnedFile(root, "thread_history_1.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file.file, { readOnly: true });
  try {
    if (!cursor) {
      const anchor = db.prepare("SELECT rollout_ordinal AS n, turn_id, item_id FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1").get(id);
      if (!anchor || !Number.isSafeInteger(anchor.n)) throw new Error("no cursor");
      return { kind: "codex", id, instance: file.instance, ...anchor };
    }
    if (cursor.instance !== file.instance || !db.prepare("SELECT 1 FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=? AND rollout_ordinal=?")
      .get(id, cursor.turn_id, cursor.item_id, cursor.n)) return "proof_unavailable";
    const rows = db.prepare(`SELECT CASE WHEN length(CAST(item_json AS BLOB)) <= 65536 THEN item_json END AS item
      FROM thread_items WHERE thread_id=? AND rollout_ordinal>? AND item_type='userMessage' ORDER BY rollout_ordinal LIMIT ?`);
    let count = 0, size = 0;
    for (const row of rows.iterate(id, cursor.n, MAX_ITEMS + 1)) {
      if (++count > MAX_ITEMS || !row.item || (size += Buffer.byteLength(row.item)) > MAX_INPUT) return "proof_unavailable";
      const item = JSON.parse(row.item);
      if (item.type !== "userMessage" || !Array.isArray(item.content)) return "proof_unavailable";
      if (item.content.length === 1 && item.content[0]?.type === "text" &&
          typeof item.content[0].text === "string" && digest(item.content[0].text) === expected) return "delivered";
    }
    return "pending";
  } finally { db.close(); }
}

function readClaude(root, id, folder, cursor, expected) {
  if (!folder || !/^[A-Za-z0-9_.-]+$/.test(folder) || folder === "." || folder === "..") throw new Error("invalid directory");
  const file = pinnedFile(root, path.join(folder, id + ".jsonl"));
  const fd = fs.openSync(file.file, "r");
  try {
    const offset = cursor?.offset ?? file.size;
    const anchor = Buffer.alloc(Math.min(offset, 128));
    if (fs.readSync(fd, anchor, 0, anchor.length, offset - anchor.length) !== anchor.length ||
        (offset && anchor.at(-1) !== 10)) throw new Error("incomplete cursor");
    if (!cursor) return { kind: "claude", id, folder, instance: file.instance, offset, anchor: digest(anchor) };
    if (cursor.instance !== file.instance || digest(anchor) !== cursor.anchor || file.size < offset ||
        file.size - offset > MAX_INPUT) return "proof_unavailable";
    const data = Buffer.alloc(file.size - cursor.offset);
    if (fs.readSync(fd, data, 0, data.length, cursor.offset) !== data.length) return "proof_unavailable";
    const lines = data.toString("utf8").split("\n");
    lines.pop(); // A partial last record may complete during the next check.
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type !== "user" || record.isMeta !== true || record.isSidechain !== false ||
          record.sessionId !== id || record.message?.role !== "user" || record.origin?.kind !== "peer" ||
          record.origin.verifiedLocal !== true || typeof record.origin.body !== "string") continue;
      const content = record.message.content;
      const text = typeof content === "string" ? content :
        Array.isArray(content) ? content.filter(p => p?.type === "text").map(p => p.text).join("\n") : "";
      if (digest(record.origin.body) === expected && text.includes(record.origin.body)) return "delivered";
    }
    return "pending";
  } finally { fs.closeSync(fd); }
}

export async function captureCursor(target, { profile = os.homedir() } = {}) {
  if (!matches(UUID, target.id)) throw new Error("invalid target");
  if (target.kind === "codex") return readCodex(path.join(profile, ".codex"), target.id);
  if (target.kind === "claude") return readClaude(path.join(profile, ".claude", "projects"), target.id, encodeProjectDir(target.cwd));
  throw new Error("unsupported provider");
}

export async function prove(cursor, expected, { profile = os.homedir() } = {}) {
  if (!cursor || !matches(UUID, cursor.id) || !/^[0-9a-f]{64}$/.test(expected)) return "proof_unavailable";
  try {
    if (cursor.kind === "codex") return await readCodex(path.join(profile, ".codex"), cursor.id, cursor, expected);
    if (cursor.kind === "claude" && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0) {
      return readClaude(path.join(profile, ".claude", "projects"), cursor.id, cursor.folder, cursor, expected);
    }
  } catch { return "proof_unavailable"; }
  return "proof_unavailable";
}
