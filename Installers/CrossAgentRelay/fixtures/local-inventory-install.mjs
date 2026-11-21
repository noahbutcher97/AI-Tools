// Preloaded only by the public-interface test. Replace the installed reader
// composition while keeping the real CLI, stdio server and resolver.
import { mock } from "node:test";
import { createLocalAddresses } from "../../../MCP-Servers/bridges/relay/local-address.mjs";

const readers = ["sample", "other"].map(kind => ({
  kind, enumerate: () => ({ complete: true, targets: [{ id: "Sample:Chat/One" }] }),
}));
const local = createLocalAddresses({ root: () => process.env.RELAY_FIXTURE_ROOT, additionalAdapters: readers });
mock.module(new URL("../../../MCP-Servers/bridges/relay/local-address.mjs", import.meta.url), {
  namedExports: { listInstalledTargets: local.list, resolveLocalAddress: local.resolve },
});
