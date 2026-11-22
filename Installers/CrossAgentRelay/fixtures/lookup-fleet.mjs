// The test loader replaces only the public lookup caller's fleet import.
// Exercise the normal SSH pipes against a local synthetic receiver process.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { parseDirectory, requestHost as requestOverPipes } from "../../../MCP-Servers/bridges/relay/fleet.mjs";
export { INVENTORY_SURVEY_MS } from "../../../MCP-Servers/bridges/relay/fleet.mjs";
import { createLocalAddresses } from "../../../MCP-Servers/bridges/relay/local-address.mjs";
import { receive } from "../../../MCP-Servers/bridges/relay/receive.mjs";
import { createRemoteLookup } from "../../../MCP-Servers/bridges/relay/remote-lookup-receiver.mjs";

const root = () => process.env.RELAY_FIXTURE_ROOT || path.join(process.env.USERPROFILE, "CrossAgentRelay");
const read = file => JSON.parse(fs.readFileSync(path.join(root(), file), "utf8"));
const thisFile = fileURLToPath(import.meta.url);

export function loadDirectory() {
  return parseDirectory(read("machine.json"), read("hosts.json"));
}

export async function requestHost(entry, request, timeoutMs) {
  fs.appendFileSync(path.join(root(), "lookup-frames.jsonl"), JSON.stringify(request) + "\n");
  const effectFixture = fs.existsSync(path.join(root(), "fixture-effects.json"));
  const script = effectFixture && entry.host === "host-b" ? fileURLToPath(new URL("./effect-peer.mjs", import.meta.url)) : thisFile;
  const result = await requestOverPipes(entry, request, timeoutMs, (_command, _args, options) =>
    spawn(process.execPath, [script, entry.host], options));
  if (effectFixture && request.op === read("fixture-effects.json").dropReply) return { error: "timeout" };
  return result;
}

async function runPeer(host) {
  if (host === "offline-peer") {
    console.error("Connection refused");
    process.exitCode = 255;
    return;
  }
  if (host === "old-peer") {
    console.log(JSON.stringify({ ok: false, error: "invalid_frame" }));
    process.exitCode = 1;
    return;
  }
  const peerRoot = () => path.join(root(), "peer");
  function recordEffect() {
    fs.appendFileSync(path.join(root(), "lookup-effects.jsonl"), "effect\n");
    throw new Error("unexpected delivery");
  }
  const shared = "--Sample:Chat/One";
  const adapters = [
    { kind: "sample", enumerate: () => ({ complete: true, targets: [{ id: shared }, { id: "--Sample:Unique/One" }] }) },
    { kind: "other", enumerate: () => ({ complete: true, targets: [{ id: shared }] }) },
    { kind: "partial", enumerate: () => ({ complete: false, targets: [] }) },
  ].map(adapter => ({ ...adapter, validId: () => true, ready: () => true, submit: recordEffect }));
  const local = createLocalAddresses({ root: peerRoot, additionalAdapters: adapters });
  const lookup = createRemoteLookup({ root: peerRoot, resolve: async selector => {
    if (host === "slow-peer") await wait(2250);
    return local.resolve(selector);
  } });
  const peer = read("machine.json").host;
  if (host === "slow-peer") await wait(800);
  const reply = await receive(["--peer", peer, "--host", host], "relay receive", process.stdin,
    3000, undefined, recordEffect, undefined, lookup);
  console.log(JSON.stringify(reply));
  process.exitCode = reply.ok ? 0 : 1;
}

if (process.argv[1] === thisFile) await runPeer(process.argv[2]);
