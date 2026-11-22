import fs from "node:fs";
import path from "node:path";
import { exactKeys, HOST, matches, UUID } from "./delivery-protocol.mjs";
import { installationRoot } from "./fleet.mjs";

export function readEnabledReceivePolicy(dir) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(dir ?? installationRoot(), "receive-policy.json"), "utf8"));
    if (exactKeys(policy, ["enabled", "codex"]) && policy.enabled === true && Array.isArray(policy.codex) &&
        policy.codex.every(row => exactKeys(row, ["peer", "ids"]) && matches(HOST, row.peer) &&
          (row.ids === "all" || (Array.isArray(row.ids) && row.ids.every(id => matches(UUID, id)))))) return policy;
  } catch { /* A missing or unreadable policy denies access. */ }
  return null;
}
