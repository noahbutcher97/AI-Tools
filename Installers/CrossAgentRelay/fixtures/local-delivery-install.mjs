import { createInstalledDelivery } from "../../../MCP-Servers/bridges/relay/installed-delivery.mjs";
import { installedAdapters, permitsLocalProof, resolveLocalAddress } from "./local-inventory-install.mjs";

const installed = createInstalledDelivery({
  resolve: resolveLocalAddress, checkProofBinding: permitsLocalProof, adapters: installedAdapters,
});
export const { sendBound, pingBound, sendLocal, pingLocal, status: localReceiptStatus } = installed;
