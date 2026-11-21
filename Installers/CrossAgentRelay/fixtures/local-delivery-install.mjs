import { createInstalledDelivery } from "../../../MCP-Servers/bridges/relay/installed-delivery.mjs";
import { installedAdapters, permitsLocalProof, resolveLocalAddress, resolveLocalAlias } from "./local-inventory-install.mjs";

const installed = createInstalledDelivery({
  resolve: resolveLocalAddress, resolveAlias: resolveLocalAlias, checkProofBinding: permitsLocalProof, adapters: installedAdapters,
});
export const { sendBound, pingBound, sendLocal, pingLocal, status: localReceiptStatus } = installed;
