// The test loader substitutes this installation binding at the public faces.
import fs from "node:fs";
import path from "node:path";
import { digest } from "../../../MCP-Servers/bridges/relay/delivery-protocol.mjs";
import { createLocalAddresses } from "../../../MCP-Servers/bridges/relay/local-address.mjs";

const validId = id => id === "Sample:Chat/One" || id === "SamplePlain";
function inbound() {
  try {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "inbound.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const recorder = {
  kind: "sample",
  enumerate: () => ({ complete: true, targets: [{ id: "Sample:Chat/One" }, { id: "SamplePlain" }] }),
  validId, ready: () => true,
  submit(binding, text) {
    fs.appendFileSync(path.join(fixtureRoot, "submitted.jsonl"), JSON.stringify({ binding, text }) + "\n");
    return { ok: true };
  },
  proof: {
    validateId: validId,
    capture(binding) {
      return { kind: binding.adapter, id: binding.id, offset: inbound().length };
    },
    verify(cursor, expected, { binding }) {
      const found = inbound().slice(cursor.offset).some(row =>
        row.binding.host === binding.host && row.binding.adapter === binding.adapter &&
        row.binding.id === binding.id && digest(row.text) === expected);
      return found ? "delivered" : "pending";
    },
  },
};
// A synthetic profile exercises the real built-in readers. An explicitly
// supplied fixture root exercises the additional adapters as well.
const fixtureRoot = process.env.RELAY_FIXTURE_ROOT;
export const installedAdapters = fixtureRoot ? [recorder, {
  kind: "other", enumerate: () => ({ complete: true, targets: [{ id: "Sample:Chat/One" }] }),
}] : [];

const local = createLocalAddresses({
  root: () => fixtureRoot || path.join(process.env.USERPROFILE, "CrossAgentRelay"),
  additionalAdapters: installedAdapters,
});
export const listInstalledTargets = local.list;
export const resolveLocalAddress = local.resolve;
export const resolveLocalAlias = local.resolveAlias;
export const permitsLocalProof = local.permitsProof;
