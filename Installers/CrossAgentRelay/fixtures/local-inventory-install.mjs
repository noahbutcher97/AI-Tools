// Preloaded only by the public-interface test. Replace the installed reader
// composition while keeping the real CLI, stdio server and resolver.
import { mock } from "node:test";
import path from "node:path";
import { createLocalAddresses } from "../../../MCP-Servers/bridges/relay/local-address.mjs";

const readers = ["sample", "other"].map(kind => ({
  kind, enumerate: () => ({ complete: true, targets: [{ id: "Sample:Chat/One" }] }),
}));
// A synthetic profile exercises the real built-in readers. An explicitly
// supplied fixture root exercises the additional adapters as well.
const fixtureRoot = process.env.RELAY_FIXTURE_ROOT;
const local = createLocalAddresses({
  root: () => fixtureRoot || path.join(process.env.USERPROFILE, "CrossAgentRelay"),
  additionalAdapters: fixtureRoot ? readers : [],
});
mock.module(new URL("../../../MCP-Servers/bridges/relay/local-address.mjs", import.meta.url), {
  namedExports: { listInstalledTargets: local.list, resolveLocalAddress: local.resolve },
});
