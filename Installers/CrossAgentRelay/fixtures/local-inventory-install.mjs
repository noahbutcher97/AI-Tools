// The test loader substitutes this installation binding at the public faces.
import path from "node:path";
import { createLocalAddresses } from "../../../MCP-Servers/bridges/relay/local-address.mjs";

const readers = ["sample", "other"].map(kind => ({
  kind, enumerate: () => ({ complete: true, targets: kind === "sample"
    ? [{ id: "Sample:Chat/One" }, { id: "SamplePlain" }] : [{ id: "Sample:Chat/One" }] }),
}));
// A synthetic profile exercises the real built-in readers. An explicitly
// supplied fixture root exercises the additional adapters as well.
const fixtureRoot = process.env.RELAY_FIXTURE_ROOT;
const local = createLocalAddresses({
  root: () => fixtureRoot || path.join(process.env.USERPROFILE, "CrossAgentRelay"),
  additionalAdapters: fixtureRoot ? readers : [],
});
export const listInstalledTargets = local.list;
export const resolveLocalAddress = local.resolve;
export const permitsLocalProof = local.permitsProof;
