import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInstalledDelivery } from "./installed-delivery.mjs";
import { createLocalAddresses } from "./local-address.mjs";

const bridge = fileURLToPath(new URL(".", import.meta.url));
const loader = new URL("../../../Installers/CrossAgentRelay/fixtures/local-inventory-loader.mjs", import.meta.url);

test("public local send and ping pin the exact binding; cold status proves only matching inbound bytes", async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bound-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, RELAY_FIXTURE_ROOT: profile };
  const nodeArgs = ["--no-warnings", "--experimental-loader", loader.href];
  const write = (file, value) => fs.writeFileSync(path.join(profile, file), JSON.stringify(value));
  const submitted = path.join(profile, "submitted.jsonl");
  const queue = () => fs.readFileSync(submitted, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  write("machine.json", { host: "host-a" });
  write("inventory-adapters.json", { enabled: ["other", "sample"] });
  const runCli = (...args) => {
    const result = spawnSync(process.execPath, [...nodeArgs, "cli.mjs", ...args], {
      cwd: bridge, env, encoding: "utf8", timeout: 15000,
    });
    if (result.error) throw result.error;
    assert.ok([0, 1].includes(result.status), result.stderr);
    return result;
  };
  const cli = (...args) => JSON.parse(runCli(...args, "--json").stdout);

  const id = "Sample:Chat/One";
  const binding = { host: "host-a", adapter: "sample", id };
  const transport = new StdioClientTransport({ command: process.execPath, args: [...nodeArgs, "server.mjs"], cwd: bridge, env, stderr: "pipe" });
  const client = new Client({ name: "bound-replay", version: "1" });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  };
  try {
    const listing = await call("relay_list", { scope: "all" });
    assert.deepEqual(listing.targets, cli("list", "--scope", "all").targets);
    const sample = listing.targets.find(row => row.kind === "sample" && row.id === id);
    assert.equal(sample.addressable, null);
    assert.match(sample.reason, /eligibility unchecked.*--dry-run/);
    const other = listing.targets.find(row => row.kind === "other" && row.id === id);
    assert.equal(other.addressable, false);
    assert.equal(other.reason, "local inventory only");
    const plain = runCli("list", "--scope", "all").stdout.trimEnd();
    assert.equal(plain, listing.rendered);
    assert.match(plain, /\[sample\][^\n]*\n\s+Delivery route installed/);
    assert.match(plain, /\[other\][^\n]*\n\s+not addressable: local inventory only/);
    assert.equal(cli("send", "--id", id, "--message", "test").cause, "ambiguous");
    assert.equal((await call("relay_send", { ...binding, adapter: "other", message: "test" })).cause, "unsupported_route");
    assert.equal((await call("relay_send", { ...binding, dry_run: true, message: "test" })).ok, true);
    assert.equal(fs.existsSync(submitted), false);
    assert.equal((await call("relay_send", { ...binding, message: "Example notice." })).state, "queued");
    assert.equal(cli("send", "SamplePlain", "--message", "From CLI").state, "queued");
    const probe = runCli("ping", "--id", id, "--adapter", "sample", "--json");
    const pending = JSON.parse(probe.stdout);
    assert.equal(pending.state, "pending");
    assert.equal(pending.dispatch, "accepted");
    assert.equal(probe.stderr.trim(), "relay receipt " + pending.handle);
    const records = queue();
    assert.equal(records.length, 3);
    assert.deepEqual(records[0].binding, binding);
    assert.equal(records[1].binding.id, "SamplePlain");
    const notice = records[2];
    assert.deepEqual(notice.binding, binding);
    assert.match(notice.text, /Delivery probe/);
    write("inbound.json", [
      { ...notice, binding: { ...binding, adapter: "other" } },
      { ...notice, binding: { ...binding, id: "SamplePlain" } },
      { ...notice, text: "Unrelated inbound message." },
    ]);
    assert.equal((await call("relay_ping", { status: pending.handle })).state, "pending");
    write("inbound.json", [notice]);
    const delivered = cli("ping", "--status", pending.handle);
    assert.equal(delivered.state, "delivered");
    assert.deepEqual(delivered.binding, binding);
    write("machine.json", { host: "host-b" });
    assert.equal((await call("relay_ping", { status: pending.handle })).state, "proof_unavailable");
    write("machine.json", { host: binding.host });
    write("inventory-adapters.json", { enabled: ["other"] });
    assert.equal(cli("ping", "--status", pending.handle).state, "proof_unavailable");
    assert.equal(queue().length, 3);
  } finally {
    await client.close();
  }
});

test("legacy name resolution refuses when a literal raw ID appears during preparation", async () => {
  let collides = false, submissions = 0;
  const row = { id: "native", name: "example", kind: "claude" };
  const resolve = async ({ id }) => {
    if (id === row.name && !collides) return { ok: false, state: "missing" };
    return { ok: true, target: { id, adapter: id === row.id ? "claude" : "sample", host: null } };
  };
  const resolveAlias = (selector, nativeId) => {
    assert.deepEqual(selector, { id: row.name });
    assert.equal(nativeId, row.id);
    return collides ? { ok: false, state: "binding_changed" } : resolve({ id: nativeId });
  };
  const installed = createInstalledDelivery({ resolve, resolveAlias, sendLegacy: async options => {
    assert.equal(await options.checkLocalBinding(row), null);
    collides = true;
    const failure = await options.checkLocalBinding(row);
    if (failure) return { ok: false, ...failure };
    submissions++;
  } });
  assert.equal((await installed.sendLocal({ to: row.name, message: "Example." })).cause, "binding_changed");
  assert.equal(submissions, 0);
});

for (const [scenario, expected] of [
  ["alias collision", "binding_changed"],
  ["incomplete reader", "incomplete_inventory"],
  ["stable alias", "accepted"],
]) test("native Claude alias delivery uses one final raw-ID survey: " + scenario, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-alias-survey-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const envKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const saved = process.env[envKey];
  process.env[envKey] = profile;
  t.after(() => { if (saved === undefined) delete process.env[envKey]; else process.env[envKey] = saved; });
  const registry = path.join(profile, ".claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  const row = { pid: 1000, sessionId: "native-chat", name: "worker", startedAt: 42, messagingSocketPath: "endpoint" };
  fs.writeFileSync(path.join(registry, "1000.json"), JSON.stringify(row));
  fs.writeFileSync(path.join(profile, "inventory-adapters.json"), JSON.stringify({ enabled: ["claude", "sample"] }));

  let final = false;
  let surveyingNativeId = false;
  let finalSurveys = 0;
  let submits = 0;
  const addresses = createLocalAddresses({ root: () => profile, additionalAdapters: [{
    kind: "sample", enumerate() {
      if (final) finalSurveys++;
      const lastNative = final && surveyingNativeId;
      return { complete: !(lastNative && scenario === "incomplete reader"),
        targets: lastNative && scenario === "alias collision" ? [{ id: row.name }] : [] };
    },
  }] });
  const installed = createInstalledDelivery({
    resolve(selector) {
      surveyingNativeId = selector.id === row.sessionId;
      return addresses.resolve(selector);
    },
    resolveAlias(selector, nativeId) {
      surveyingNativeId = nativeId === row.sessionId;
      return addresses.resolveAlias(selector, nativeId);
    },
  });
  const result = await installed.sendLocal({
    to: row.name, message: "Synthetic alias probe.", allowDelegate: true, beforeSubmit() { final = true; },
    runDelegate() { submits++; return { code: 0, stdout: "RELAY-OK" }; },
  });
  if (expected === "accepted") {
    assert.equal(submits, 1);
    assert.equal(result.ok, true);
  } else {
    assert.equal(submits, 0);
    assert.equal(result.dispatch, "not_submitted");
    assert.equal(result.cause, expected);
  }
  assert.equal(finalSurveys, 1);
});
