// Each call starts a fresh process, with durable policy and receipts in the
// disposable peer installation. Only the synthetic reader and transport vary.
import fs from "node:fs";
import path from "node:path";
import { digest } from "../../../MCP-Servers/bridges/relay/delivery-protocol.mjs";
import { createLocalAddresses } from "../../../MCP-Servers/bridges/relay/local-address.mjs";
import { receive } from "../../../MCP-Servers/bridges/relay/receive.mjs";
import { openReceipts } from "../../../MCP-Servers/bridges/relay/receipts.mjs";
import { dispatchRemote } from "../../../MCP-Servers/bridges/relay/remote-delivery.mjs";
import { effectAllowed } from "../../../MCP-Servers/bridges/relay/remote-effect.mjs";
import { createRemoteLookup } from "../../../MCP-Servers/bridges/relay/remote-lookup-receiver.mjs";

const dir = path.join(process.env.RELAY_FIXTURE_ROOT, "peer");
const config = JSON.parse(fs.readFileSync(path.join(process.env.RELAY_FIXTURE_ROOT, "fixture-effects.json"), "utf8"));
const log = path.join(dir, "submitted.jsonl");
const inbox = path.join(dir, "inbound.json");
const inbound = () => fs.existsSync(inbox) ? JSON.parse(fs.readFileSync(inbox, "utf8")) : [];
const adapters = ["sample", "other"].map(kind => ({
  kind, validId: () => true, ready: () => true,
  enumerate: () => ({ complete: true, targets: config[kind].map(id => ({ id })) }),
  submit(binding, text) {
    fs.appendFileSync(log, JSON.stringify({ binding, text }) + "\n");
    return { ok: true };
  },
  proof: {
    validateId: () => true,
    capture(binding) { return { kind, id: binding.id, offset: inbound().length }; },
    verify(cursor, expected, { binding }) {
      return inbound().slice(cursor.offset).some(row => row.binding.host === binding.host &&
        row.binding.id === cursor.id && row.binding.adapter === kind && digest(row.text) === expected) ? "delivered" : "pending";
    },
  },
}));
const addresses = createLocalAddresses({ root: () => dir, additionalAdapters: adapters });
const lookup = createRemoteLookup({ root: () => dir, resolve: addresses.resolve });
const options = {
  resolve: addresses.resolve, permitsProof: addresses.permitsProof, adapters,
  permit: (peer, binding, action) => effectAllowed(peer, binding, action, dir),
  receipts: () => openReceipts(path.join(dir, "receipts.sqlite")),
};
const reply = await receive(["--peer", "host-a", "--host", process.argv[2]], "relay receive", process.stdin, 3000,
  undefined, (request, peer) => dispatchRemote(request, peer, options), undefined, lookup);
if (config.wrongReply && reply.v === 4) reply.adapter = "different";
if (config.substituteState?.op === reply.op) reply.state = config.substituteState.state;
console.log(JSON.stringify(reply));
process.exitCode = reply.ok ? 0 : 1;
