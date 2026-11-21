// Only the test loader imports this fixture. Submissions and inbound records
// are separate files so the test controls when proof can become available.
import fs from "node:fs";
import path from "node:path";
import { digest } from "../../../MCP-Servers/bridges/relay/delivery-protocol.mjs";
import { createInstalledDelivery } from "../../../MCP-Servers/bridges/relay/installed-delivery.mjs";
import { permitsLocalProof, resolveLocalAddress } from "./local-inventory-install.mjs";

const root = process.env.RELAY_FIXTURE_ROOT;
const validId = id => id === "Sample:Chat/One" || id === "SamplePlain";
function inbound() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "inbound.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const recorder = {
  kind: "sample", validId, ready: () => true,
  submit(binding, text) {
    fs.appendFileSync(path.join(root, "submitted.jsonl"), JSON.stringify({ binding, text }) + "\n");
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
const installed = createInstalledDelivery({
  resolve: resolveLocalAddress, checkProofBinding: permitsLocalProof, adapters: root ? [recorder] : [],
});
export const { sendBound, pingBound, sendLocal, pingLocal, status: localReceiptStatus } = installed;
