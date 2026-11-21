import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { localStatus } from "../../../MCP-Servers/bridges/relay/local-ping.mjs";
import { prove } from "../../../MCP-Servers/bridges/relay/proof.mjs";

// The qualification is the only caller that asks the exact-content verifier
// to retain a turn binding. Regular status results expose only delivery.
export async function checkTurnReceipt(handle, profile) {
  let binding;
  const status = await localStatus(handle, { profile, verify: (cursor, expected, options) =>
    cursor.kind === "codex" ? prove(cursor, expected, { ...options, onCodexTurn: value => { binding = value; } }) : "proof_unavailable" });
  return { status, binding };
}

export async function receiptStillMatches(record, profile) {
  if (!record?.binding) return false;
  const { status, binding } = await checkTurnReceipt(record.handle, profile);
  return status.state === "delivered" && isDeepStrictEqual(record.binding, binding);
}

// The parent supplies an open private receipt file as stdin. Never print it.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const file = fs.fstatSync(0);
    if (!file.isFile() || file.size > 16384) throw Error();
    if (!await receiptStillMatches(JSON.parse(fs.readFileSync(0, "utf8")))) throw Error();
  } catch {
    process.stderr.write("Turn receipt could not be confirmed.\n");
    process.exitCode = 1;
  }
}
