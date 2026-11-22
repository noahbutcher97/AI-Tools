import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requestHost } from "./fleet.mjs";

const bridge = fileURLToPath(new URL(".", import.meta.url));
const loader = new URL("../../../Installers/CrossAgentRelay/fixtures/local-inventory-loader.mjs", import.meta.url);
const nodeArgs = ["--no-warnings", "--experimental-loader", loader.href];
const unique = "--Sample:Unique/One";
const shared = "--Sample:Chat/One";
const hosts = ["host-a", "host-b", "old-peer", "offline-peer", "slow-peer"].map(host => ({
  host, endpoint: host, port: 22, user: "operator",
}));

test("CLI and MCP resolve the same literal on one enrolled host with just one body-free request", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lookup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  fs.mkdirSync(path.join(root, "peer"));
  write("machine.json", { host: "host-a" });
  write("hosts.json", hosts);
  write("peer/machine.json", { host: "host-b" });
  write("peer/receive-policy.json", { enabled: true, codex: [] });
  write("peer/lookup-policy.json", { v: 1, grants: [{ peer: "host-a", ids: [shared, unique, "Absent"] }] });
  write("peer/inventory-adapters.json", { enabled: ["sample", "other"] });
  const framesFile = path.join(root, "lookup-frames.jsonl");
  const frames = () => fs.existsSync(framesFile) ? fs.readFileSync(framesFile, "utf8").trimEnd().split("\n").map(JSON.parse) : [];
  const env = { ...process.env, HOME: root, USERPROFILE: root, RELAY_FIXTURE_ROOT: root };
  const cli = (...args) => spawnSync(process.execPath, [...nodeArgs, "cli.mjs", ...args], {
    cwd: bridge, env, encoding: "utf8", timeout: 15000,
  });
  const client = new Client({ name: "lookup-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [...nodeArgs, "server.mjs"], cwd: bridge, env, stderr: "pipe",
  }));
  t.after(() => client.close());

  async function check(selector, state, count = 1) {
    const before = frames().length;
    const args = ["resolve", "--json", "--host", selector.host, "--id=" + selector.id];
    if (selector.adapter !== undefined) args.push("--adapter", selector.adapter);
    const run = cli(...args);
    assert.equal(run.status, state === "resolved" ? 0 : 1, run.error?.message ?? run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.state, state);
    assert.equal(result.ok, state === "resolved");
    assert.deepEqual(Object.keys(result).sort(), state === "resolved" ? ["detail", "ok", "state", "target"] : ["detail", "ok", "state"]);
    assert.ok(result.detail);
    if (result.ok) assert.deepEqual(result.target, { host: selector.host, id: selector.id, adapter: selector.adapter ?? "sample" });
    assert.equal(frames().length - before, count);
    const response = await client.callTool({ name: "relay_resolve", arguments: selector });
    assert.equal(Boolean(response.isError), !result.ok);
    assert.deepEqual(JSON.parse(response.content[0].text), result);
    const sent = frames().slice(before);
    assert.equal(sent.length, 2 * count);
    for (const { requestId, ...body } of sent) {
      assert.match(requestId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(body, { v: 3, op: "lookup", ...selector });
    }
    return result;
  }
  const host = "host-b";
  await check({ host, id: unique }, "resolved");
  await check({ host, id: shared }, "ambiguous");
  await check({ host, id: shared, adapter: "other" }, "resolved");
  await check({ host, id: "Absent" }, "missing");
  await check({ host, id: "Denied" }, "receive_denied");
  await check({ host, id: shared, adapter: "absent" }, "unknown_adapter");
  write("peer/inventory-adapters.json", { enabled: ["sample", "partial"] });
  await check({ host, id: unique }, "incomplete_inventory");
  await check({ host, id: unique, adapter: "sample" }, "resolved");
  assert.match((await check({ host: "old-peer", id: unique }, "lookup_refused")).detail, /older relay/);
  await check({ host: "offline-peer", id: unique }, "offline");
  await check({ host: "absent-peer", id: shared }, "unknown_host", 0);
  await check({ host, id: shared, adapter: "../bad" }, "invalid_selector", 0);
  write("peer/machine.json", { host: "slow-peer" });
  await check({ host: "slow-peer", id: unique, adapter: "sample" }, "resolved");
  const before = frames().length;
  assert.equal(cli("resolve", "--host", host, "--id=" + shared, "--message", "example").status, 2);
  const invalid = await client.callTool({ name: "relay_resolve", arguments: { host, id: shared, message: "example" } });
  assert.equal(invalid.isError, true);
  assert.equal(frames().length, before);
  assert.equal(fs.existsSync(path.join(root, "lookup-effects.jsonl")), false);
  assert.equal(fs.existsSync(path.join(root, "peer", "receipts.sqlite")), false);
});

test("only the legacy frame refusal is classified as a possible old receiver", async () => {
  const lookup = { v: 3, op: "lookup" };
  const sendFixture = (request, text, code) => requestHost(hosts[1], request, 3000, (_command, _args, options) =>
    spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.exitCode=Number(process.argv[2])", text, String(code)], options));
  const refusal = '{"ok":false,"error":"invalid_frame"}\n';
  assert.deepEqual(await sendFixture(lookup, refusal, 1), { error: "lookup_refused" });
  assert.deepEqual(await sendFixture({ v: 2, op: "resolve" }, refusal, 1), { error: "receive_failed" });
  assert.deepEqual(await sendFixture(lookup, refusal, 255), { error: "receive_failed" });
  assert.deepEqual(await sendFixture(lookup, refusal + "diagnostics", 1), { error: "receive_failed" });
  assert.deepEqual(await sendFixture(lookup, '{"v":2,"v":3}\n', 0), { error: "invalid_response" });
});
