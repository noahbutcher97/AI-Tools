import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "./client.mjs";
import { buildFingerprint, checkReadiness, fleetReadiness, loadedBuild, providerAuth, readReadiness, validRecord } from "./readiness.mjs";

function setup(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-health-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const hosts = ["host-a","host-b","host-c"].map(host => ({ host, endpoint: host, user: "operator", port: 22 }));
  const directory = () => ({ local: "host-a", hosts });
  const now = Date.now();
  return { profile, directory, now, list: async () => ({ targets: [], partial: false }),
    check: async () => ({ state: "signed_in", expiresAt: null, expiry: "not_exposed" }),
    ping: () => assert.fail("no live wake permitted") };
}

test("provider status returns only sign-in and actual expiry fields", async () => {
  const resolve = () => ({ command: process.execPath, prefix: ["fixture"] });
  const now = Date.now(), expires = new Date(now + 30000).toISOString();
  const run = async (_, args) => {
    assert.deepEqual(args, ["fixture","auth","status","--json"]);
    return { code: 0, stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: expires, private: "discard" }) };
  };
  assert.deepEqual(await providerAuth("claude", { resolve, now, run }), { state: "signed_in", expiresAt: expires, expiry: "reported" });
  assert.equal((await providerAuth("claude", { resolve, now: now + 60000, run })).state, "expired");
  assert.deepEqual(await providerAuth("codex", { resolve, run: async (_, args) => {
    assert.deepEqual(args, ["fixture","login","status"]); return { code: 0, stderr: "Logged in using fixture" };
  } }), { state: "signed_in", expiresAt: null, expiry: "not_exposed" });
  assert.equal((await providerAuth("codex", { resolve, run: async () => ({ code: 1, stderr: "Not logged in" }) })).state, "signed_out");
});

test("the fleet compares identical source across checkout line endings", t => {
  const { profile } = setup(t);
  const file = path.join(profile, "fixture.mjs");
  fs.writeFileSync(file, "export default 1;\n");
  const first = buildFingerprint(profile);
  fs.writeFileSync(file, "export default 1;\r\n");
  assert.equal(buildFingerprint(profile), first);
  fs.writeFileSync(file, "export default 2;\r\n");
  assert.notEqual(buildFingerprint(profile), first);
});

test("plain doctor writes a dated record, remote reads never launch or publish private data", async t => {
  const opts = setup(t);
  assert.equal(readReadiness(opts.profile), null);
  const record = await checkReadiness(opts);
  assert.equal(validRecord(record), true);
  const { watcher, ...legacy } = record;
  assert.ok(watcher);
  assert.equal(validRecord({ ...legacy, v: 1 }), true);
  assert.equal(validRecord({ ...record, watcher: { state: "unavailable", record: null, detail: "fixture" } }), false);
  assert.equal(record.delegate.state, "not_checked");
  assert.deepEqual(readReadiness(opts.profile), record);
  const file = path.join(opts.profile, ".cross-agent-relay", "readiness.json");
  fs.writeFileSync(file, JSON.stringify({ ...record, privateNote: "discard" }));
  assert.equal(readReadiness(opts.profile), null);
});

test("all-hosts doctor queries peers concurrently and reports build and connectivity separately", async t => {
  const opts = setup(t), local = await checkReadiness(opts), now = () => opts.now;
  const pending = new Map();
  const result = fleetReadiness({ local, now, directory: opts.directory(), query: (entry, frame) =>
    new Promise(resolve => pending.set(entry.host, { frame, resolve })) });
  assert.equal(pending.size, 2);
  pending.get("host-b").resolve({ error: "offline" });
  const { frame, resolve } = pending.get("host-c");
  resolve({ reply: { ...frame, ok: true, peer: "host-a", host: "host-c", record: local, time: local.checkedAt, build: "0".repeat(64) } });
  assert.deepEqual((await result).hosts.map(h => h.status), ["degraded","offline","build_mismatch"]);
  assert.equal(fs.existsSync(path.join(opts.profile, ".cross-agent-relay", "fleet-readiness.json")), false);
});

test("fleet doctor refuses overbroad records and marks skewed evidence", async t => {
  const opts = setup(t), local = await checkReadiness(opts);
  const report = await fleetReadiness({ local, now: () => opts.now, directory: opts.directory(), query: async (entry, frame) => ({
    reply: { ...frame, ok: true, peer: "host-a", host: entry.host, build: loadedBuild,
      record: entry.host === "host-b" ? { ...local, extra: "private text" } : local, time: new Date(opts.now+60000).toISOString() },
  }) });
  assert.deepEqual(report.hosts.map(h => h.status), ["degraded","invalid_response","clock_skew"]);
  assert.doesNotMatch(JSON.stringify(report), /private text/);
});

test("fleet doctor retains validated local evidence when no host directory is available", async t => {
  const opts = setup(t);
  const local = await checkReadiness({ ...opts, directory() { throw Error("unconfigured"); } });
  const options = { directory: null, profile: opts.profile, now: () => opts.now, query: assert.fail };
  const file = path.join(opts.profile, ".cross-agent-relay", "fleet-readiness.json");
  const report = await fleetReadiness({ ...options, local });
  assert.deepEqual(report, { v: 1, checkedAt: local.checkedAt, ready: false, reason: "directory_unavailable", hosts: [], local });
  assert.equal(fs.existsSync(file), false);
  assert.equal((await fleetReadiness({ ...options, local: { ...local, extra: "fixture" } })).local, null);
  await fleetReadiness({ ...options, local, persist: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), report);
});

test("doctor probes require a designated local Claude session and explicit CLI opt-in", async t => {
  const opts = setup(t);
  const target = "00000000-0000-4000-8000-000000000001";
  await assert.rejects(checkReadiness({ ...opts, target, designated: () => null }), /designated/);
  await assert.rejects(checkReadiness({ ...opts, target, designated: () => target }), /unavailable/);
  assert.throws(() => parseArgs(["doctor","--all-hosts","--probe-target",target]));
  assert.equal(parseArgs(["doctor","--probe-target",target]).probeTarget, target);
});
