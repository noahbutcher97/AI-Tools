// Loaded only by the walkthrough child process. The real CLI parses and renders
// each command. Session discovery, submissions and receipt storage are fixtures.
import fs from "node:fs";
import { mock } from "node:test";
import * as fleet from "../../../MCP-Servers/bridges/relay/fleet.mjs";
import * as addressed from "../../../MCP-Servers/bridges/relay/addressed-send.mjs";

const bridge = new URL("../../../MCP-Servers/bridges/relay/", import.meta.url);
const file = process.env.RELAY_OPERATOR_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const directory = { local: "desk-a", hosts: [{ host: "desk-a" }, { host: "desk-b" }] };
const localInventory = () => ({ partial: false, targets: [] });
const refused = () => ({ ok: false, cause: "unresolved", detail: "No matching local session." });
async function query(entry, frame) {
  const reply = { v: frame.v, ok: true, op: frame.op, peer: directory.local, host: entry.host, requestId: frame.requestId };
  if (frame.op === "inventory") return { reply: { ...reply, partial: false, targets: state.targets } };
  if (frame.op === "probe") return { reply };
  if (frame.op === "resolve") {
    const target = state.targets.find(t => t.id === frame.to);
    return { reply: { ...reply, state: target?.addressable ? "eligible" : "unresolved" } };
  }
  if (frame.op === "status") {
    const matching = state.effects.find(e => e.id === frame.requestId);
    const status = !matching ? "missing" : matching.op === "ping" ? "delivered" : "queued";
    if (status === "delivered") state.proved = matching.to;
    fs.writeFileSync(file, JSON.stringify(state));
    return { reply: { ...reply, state: status } };
  }
  if (!["ping", "send"].includes(frame.op)) throw Error("Unsupported fixture operation");
  state.effects.push({ op: frame.op, to: frame.to, id: frame.requestId });
  fs.writeFileSync(file, JSON.stringify(state));
  // Submission was possible before contact was lost. Only a probe has a
  // consumption receipt. A status lookup cannot prove an ordinary queued send.
  return { error: "timeout" };
}
const adapters = { directory: () => directory, query, local: refused };
mock.module(new URL("fleet.mjs", bridge), { namedExports: { ...fleet,
  queryFleet: op => fleet.queryFleet(op, { directory, query, localInventory }) } });
mock.module(new URL("addressed-send.mjs", bridge), { namedExports: {
  sendAddressed: (options, hooks) => addressed.sendAddressed(options, { ...hooks, ...adapters }),
  pingTarget: (target, hooks) => addressed.pingTarget(target, { ...hooks, ...adapters }),
  sendStatus: handle => handle.startsWith("local-proof.") ? refused() : addressed.sendStatus(handle, adapters),
} });
