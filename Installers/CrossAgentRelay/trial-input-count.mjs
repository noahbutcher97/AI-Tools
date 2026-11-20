import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matches, UUID } from "../../MCP-Servers/bridges/relay/delivery-protocol.mjs";

// Used only for the new disposable thread in the installed branch trial.
// The broker proves the exact payload. This second check counts inbound items
// independently, so even a duplicate carrying a different envelope is visible.
export async function trialInputCount(thread, seed, activation, profile = os.homedir()) {
  if (![thread, seed].every(id => matches(UUID, id)) ||
      (activation !== undefined && (!matches(UUID, activation) || seed === activation))) return "unknown";
  try {
    const file = path.join(profile, ".codex", "thread_history_1.sqlite");
    if (!path.isAbsolute(profile) || path.relative(file, fs.realpathSync.native(file)) !== "") return "unknown";
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT turn_id FROM thread_items
        WHERE thread_id=? AND item_type='userMessage' ORDER BY rollout_ordinal LIMIT 5`).all(thread);
      const expected = activation === undefined ? [seed] : [seed, activation];
      if (expected.some((turn, i) => rows[i]?.turn_id !== turn)) return "unknown";
      const rest = rows.slice(expected.length);
      if (rest.some(row => !matches(UUID, row.turn_id) || expected.includes(row.turn_id))) return "unknown";
      return rest.length === 0 ? "none" : rest.length === 1 ? "one" : "extra";
    } finally { db.close(); }
  } catch { return "unknown"; }
}
