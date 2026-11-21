import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLocalAddresses } from "./local-address.mjs";
import { createInstalledDelivery } from "./installed-delivery.mjs";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-local-address-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const readers = ["sample", "other"].map(kind => ({
    kind, enumerate() {
      calls.push(kind);
      return { targets: [{ id: "--Chat:A/B" }], complete: true };
    },
  }));
  const write = (name, record) => fs.writeFileSync(path.join(root, name), JSON.stringify(record));
  write("inventory-adapters.json", { enabled: ["sample"] });
  return { local: createLocalAddresses({ root: () => root, additionalAdapters: readers }), write, calls };
}

test("local list and exact lookup use the same installed readers before and after enrollment", async t => {
  const { local, write, calls } = setup(t);
  const id = "--Chat:A/B";
  const list = await local.list({ scope: "all" });
  assert.deepEqual(list.inventory, [{ kind: "sample", complete: true }]);
  assert.deepEqual((await local.resolve({ id })).target, { host: null, adapter: "sample", id });
  write("machine.json", { host: "host-a" });
  assert.deepEqual((await local.resolve({ host: "host-a", id })).target, { host: "host-a", adapter: "sample", id });
  write("inventory-adapters.json", { enabled: ["sample", "other"] });
  assert.equal((await local.resolve({ id })).state, "ambiguous");
  assert.equal((await local.resolve({ id, adapter: "other" })).target.adapter, "other");
  assert.deepEqual(calls, ["sample", "sample", "sample", "sample", "other", "other"]);
});

test("an invalid installation or explicit host mismatch refuses before enumeration", async t => {
  const { local, write, calls } = setup(t);
  const selector = { id: "Example", host: "host-a" };
  assert.equal((await local.resolve({ id: "Example", enabled: ["sample"] })).state, "invalid_selector");
  assert.equal((await local.resolve(selector)).state, "host_unavailable");
  write("machine.json", { host: "host-b" });
  assert.equal((await local.resolve(selector)).state, "nonlocal_host");
  write("machine.json", { host: "host-a", extra: true });
  assert.equal((await local.resolve(selector)).state, "host_unavailable");
  write("machine.json", { host: "host-a" });
  for (const config of [{ enabled: ["missing"] }, { enabled: [] }, { enabled: ["sample", "sample"] },
    { enabled: ["sample"], extra: true }, null]) {
    write("inventory-adapters.json", config);
    const list = await local.list({ scope: "all" });
    assert.equal(list.complete, false);
    assert.deepEqual(list.targets, []);
    assert.equal((await local.resolve(selector)).state, "inventory_unavailable");
  }
  assert.deepEqual(calls, []);
});

function changingInstallation(t, { change, during = 2, present = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-changing-installation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  write("machine.json", { host: "host-a" });
  write("inventory-adapters.json", { enabled: ["sample"] });
  const id = "Chat:One";
  let reads = 0;
  let submissions = 0;
  let legacyCalls = 0;
  const adapters = ["sample", "other"].map(kind => ({
    kind,
    async enumerate() {
      if (kind === "sample" && ++reads === during) {
        await Promise.resolve();
        change(write);
      }
      return { targets: present || kind === "other" ? [{ id }] : [], complete: true };
    },
    validId: value => value === id,
    ready: () => true,
    submit() { submissions++; return { ok: true }; },
  }));
  const addresses = createLocalAddresses({ root: () => root, additionalAdapters: adapters });
  const dispatch = createInstalledDelivery({
    resolve: addresses.resolve, adapters, sendLegacy() { legacyCalls++; return { ok: true }; },
  });
  return { dispatch, id, counts: () => ({ reads, submissions, legacyCalls }) };
}

const expandReaders = write => write("inventory-adapters.json", { enabled: ["sample", "other"] });
for (const [scenario, selector, change] of [
  ["host changed", { host: "host-a", adapter: "sample" }, write => write("machine.json", { host: "host-b" })],
  ["reader withdrawn", { adapter: "sample" }, write => write("inventory-adapters.json", { enabled: ["other"] })],
  ["unqualified lookup gained a competing reader", {}, expandReaders],
]) {
  test("a change during the final enumeration prevents submission: " + scenario, async t => {
    const fixture = changingInstallation(t, { change });
    const result = await fixture.dispatch.sendBound({ ...selector, id: fixture.id }, { message: "Synthetic notice." });
    assert.equal(result.cause, "installation_changed");
    assert.equal(result.dispatch, "not_submitted");
    assert.deepEqual(fixture.counts(), { reads: 2, submissions: 0, legacyCalls: 0 });
  });
}

test("a qualified lookup can finish when an unrelated reader becomes enabled", async t => {
  const fixture = changingInstallation(t, { change: expandReaders });
  const result = await fixture.dispatch.sendBound({ id: fixture.id, adapter: "sample" }, { message: "Synthetic notice." });
  assert.equal(result.dispatch, "accepted");
  assert.deepEqual(fixture.counts(), { reads: 2, submissions: 1, legacyCalls: 0 });
});

test("a missing lookup cannot start legacy delivery after the installed readers change", async t => {
  const fixture = changingInstallation(t, { change: expandReaders, during: 1, present: false });
  const result = await fixture.dispatch.sendLocal({ to: fixture.id, message: "Synthetic notice." });
  assert.equal(result.dispatch, "not_submitted");
  assert.equal(result.cause, "installation_changed");
  assert.deepEqual(fixture.counts(), { reads: 1, submissions: 0, legacyCalls: 0 });
});

test("CLI and MCP select the same literal ID from an independently composed reader", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reader-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, RELAY_FIXTURE_ROOT: root };
  const loader = new URL("../../../Installers/CrossAgentRelay/fixtures/local-inventory-loader.mjs", import.meta.url);
  const args = ["--no-warnings", "--experimental-loader", loader.href];
  const bridge = fileURLToPath(new URL(".", import.meta.url));
  const config = path.join(root, "inventory-adapters.json");
  const id = "Sample:Chat/One";
  fs.writeFileSync(config, JSON.stringify({ enabled: ["sample", "other"] }));
  fs.writeFileSync(path.join(root, "machine.json"), JSON.stringify({ host: "host-a" }));
  const cli = execFileSync(process.execPath, [...args, "cli.mjs", "resolve", "--id", id, "--adapter", "other", "--json"], {
    cwd: bridge, env, encoding: "utf8", timeout: 15000,
  });
  const client = new Client({ name: "inventory-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [...args, "server.mjs"], cwd: bridge, env, stderr: "pipe" });
  await client.connect(transport);
  try {
    const call = async selector => {
      const result = await client.callTool({ name: "relay_resolve", arguments: selector });
      return JSON.parse(result.content[0].text);
    };
    const expected = { host: "host-a", adapter: "other", id };
    assert.deepEqual(JSON.parse(cli).target, expected);
    assert.deepEqual((await call({ id, adapter: "other" })).target, expected);
    assert.equal((await call({ id })).state, "ambiguous");
    fs.writeFileSync(config, JSON.stringify({ enabled: ["other"] }));
    assert.deepEqual((await call({ id })).target, expected);
  } finally {
    await client.close();
  }
});
