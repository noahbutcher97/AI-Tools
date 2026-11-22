import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalAddresses } from "./local-address.mjs";
import { validLookupReply } from "./lookup-protocol.mjs";
import { receive } from "./receive.mjs";
import { createRemoteLookup } from "./remote-lookup-receiver.mjs";

const peer = "host-a";
const host = "host-b";
const binding = ["--peer", peer, "--host", host];
const id = "Sample:Chat/One";
const request = { v: 3, op: "lookup", requestId: "00000000-0000-4000-8000-000000000001", host, id };
const header = { ok: true, v: 3, op: "lookup", requestId: request.requestId, host, peer };
const target = { host, id, adapter: "sample" };
const readGrant = { v: 1, grants: [{ peer, ids: [id, "Absent"] }] };

function setup(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lookup-test-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const dir = path.join(profile, "CrossAgentRelay");
  fs.mkdirSync(dir);
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  write("machine.json", { host });
  write("receive-policy.json", { enabled: true, codex: [] });
  return { profile, dir, write };
}

function runReceive(frame, lookup, dispatch, args = binding) {
  const bytes = Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame));
  return receive(args, "relay receive", Readable.from([bytes]), 3000, undefined, dispatch, undefined, lookup);
}

function profileCli(profile, cli, args, input) {
  const preload = fileURLToPath(new URL("./fixtures/receive-test-root.cjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--require", preload, cli, ...args], {
    input, encoding: "utf8", timeout: 15000,
    env: { ...process.env, RELAY_RECEIVE_TEST_ROOT: profile, HOME: profile, USERPROFILE: profile,
      SSH_ORIGINAL_COMMAND: "relay receive" },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

test("v3 receive resolves exact installed reader identities without accessing an effect route", async t => {
  const { dir, write } = setup(t);
  const calls = { surveys: [], submissions: 0, dispatches: 0, proofs: 0 };
  let otherComplete = true;
  const reader = kind => ({
    kind, validId: () => true, ready: () => true, submit() { calls.submissions++; },
    proof: { capture() { calls.proofs++; }, verify() { calls.proofs++; } },
    enumerate() {
      calls.surveys.push(kind);
      return { targets: [{ id, cwd: "private-test-directory", message: "private-test-content" }],
        complete: kind === "sample" || otherComplete };
    },
  });
  const root = () => dir;
  const local = createLocalAddresses({ root, additionalAdapters: [reader("sample"), reader("other")] });
  const lookup = createRemoteLookup({ root, resolve: local.resolve });
  const run = frame => runReceive(frame, lookup, () => calls.dispatches++);
  write("inventory-adapters.json", { enabled: ["sample"] });
  write("lookup-policy.json", readGrant);
  assert.deepEqual(await run(request), { ...header, state: "resolved", target });
  write("inventory-adapters.json", { enabled: ["sample", "other"] });
  assert.deepEqual(await run(request), { ...header, state: "ambiguous" });
  assert.deepEqual(await run({ ...request, id: "Absent" }), { ...header, state: "missing" });
  otherComplete = false;
  assert.deepEqual(await run(request), { ...header, state: "incomplete_inventory" });
  const count = calls.surveys.length;
  assert.deepEqual(await run({ ...request, adapter: "sample" }), { ...header, state: "resolved", target });
  assert.deepEqual(await run({ ...request, adapter: "unknown" }), { ...header, state: "unknown_adapter" });
  assert.deepEqual(calls.surveys.slice(count), ["sample"]);
  assert.equal(calls.dispatches, 0);
  assert.equal(calls.submissions, 0);
  assert.equal(calls.proofs, 0);
  assert.equal(fs.existsSync(path.join(dir, "receipts.sqlite")), false);
});

test("v3 policy denies before surveying and rechecks revocation for positive and negative observations", async t => {
  const { dir, write } = setup(t);
  let surveys = 0;
  let duringSurvey = () => ({ ok: true, state: "resolved", target });
  const lookup = createRemoteLookup({ root: () => dir, resolve: async () => { surveys++; return duringSurvey(); } });
  const denied = { ...header, state: "receive_denied" };
  // Even an all-Codex effect grant cannot authorize a single lookup.
  write("receive-policy.json", { enabled: true, codex: [{ peer, ids: "all" }] });
  assert.deepEqual(await runReceive(request, lookup), denied);
  for (const policy of [{ v: 2, grants: [] }, { v: 1, grants: [{ peer, ids: "all" }] },
    { v: 1, grants: [{ peer: "another-peer", ids: [id] }] }, { v: 1, grants: [{ peer, ids: [id.toLowerCase()] }] },
    { v: 1, grants: [...readGrant.grants, { peer, ids: [17] }] }]) {
    write("lookup-policy.json", policy);
    assert.deepEqual(await runReceive(request, lookup), denied);
  }
  write("lookup-policy.json", readGrant);
  write("receive-policy.json", { enabled: false, codex: [] });
  assert.deepEqual(await runReceive(request, lookup), denied);
  write("receive-policy.json", { enabled: true, codex: "invalid" });
  assert.deepEqual(await runReceive(request, lookup), denied);
  write("receive-policy.json", { enabled: true, codex: [] });
  assert.deepEqual(await runReceive({ ...request, id: "Unlisted", adapter: "sample" }, lookup), denied);
  assert.deepEqual(await runReceive({ ...request, host: "another-host" }, lookup), { ok: false, error: "receive_denied" });
  assert.deepEqual(await runReceive(request, lookup, undefined, ["--peer", host, "--host", host]),
    { ok: false, error: "receive_denied" });
  assert.equal(surveys, 0);
  duringSurvey = () => {
    write("lookup-policy.json", { v: 1, grants: [] });
    return { ok: true, state: "resolved", target };
  };
  assert.deepEqual(await runReceive(request, lookup), denied);
  write("lookup-policy.json", readGrant);
  duringSurvey = () => {
    write("receive-policy.json", { enabled: false, codex: [] });
    return { ok: false, state: "ambiguous", adapters: ["private-reader"] };
  };
  assert.deepEqual(await runReceive(request, lookup), denied);
  assert.equal(surveys, 2);
});

test("receiver rejects extra fields, duplicate JSON members and malformed literal selectors before dispatch", async () => {
  let dispatches = 0;
  const used = () => dispatches++;
  const text = JSON.stringify(request);
  for (const frame of [text + text, text.replace('"v":3', '"v":2,"v":3'),
    { ...request, op: "send" }, { ...request, v: 2 }, { ...request, message: "private-test-content" },
    { ...request, id: "one\ntwo" }, { ...request, id: "\ud800" }, { ...request, id: "x".repeat(257) },
    { ...request, adapter: null }, { ...request, adapter: "../other" }, { ...request, peer }]) {
    assert.deepEqual(await runReceive(frame, used, used), { ok: false, error: "invalid_frame" });
  }
  assert.equal(dispatches, 0);
});

test("projection and caller validation bind peer, request, host, selector and reply shape", async t => {
  const { dir, write } = setup(t);
  write("lookup-policy.json", readGrant);
  const qualified = { ...request, adapter: "sample" };
  let observed = { ok: true, state: "resolved", target: { ...target, cwd: "private-directory" }, detail: "private" };
  const lookup = createRemoteLookup({ root: () => dir, resolve: async () => observed });
  const expected = { ...header, state: "resolved", target };
  assert.deepEqual(await runReceive(qualified, lookup), expected);
  for (const value of [{ ...target, id: "Other" }, { ...target, host: "another-host" },
    { ...target, adapter: "different" }, { ...target, adapter: "bad\nlabel" }]) {
    observed = { ok: true, state: "resolved", target: value };
    assert.deepEqual(await runReceive(qualified, lookup), { ...header, state: "unavailable" });
    assert.equal(validLookupReply({ ...expected, target: value }, qualified, peer), false);
  }
  assert.equal(validLookupReply(expected, qualified, peer), true);
  for (const reply of [{ ...expected, requestId: "other" }, { ...expected, op: "resolve" },
    { ...expected, state: "eligible" }, { ...expected, peer: host }, { ...expected, v: 2 },
    { ...expected, warning: "private" }, { ...expected, target: { ...target, cwd: "private" } },
    { ...header, state: "ambiguous", adapters: ["private"] }]) {
    assert.equal(validLookupReply(reply, qualified, peer), false);
  }
});

test("Windows forced CLI uses installed read policy and enrolled identity for disposable registry metadata", {
  skip: process.platform !== "win32",
}, t => {
  const { profile, dir, write } = setup(t);
  const registry = path.join(profile, ".claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, "fixture.json"), JSON.stringify({ sessionId: id, cwd: profile }));
  write("inventory-adapters.json", { enabled: ["claude"] });
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = () => profileCli(profile, cli, ["receive", ...binding], JSON.stringify({ ...request, adapter: "claude" }));
  assert.deepEqual(run(), { ...header, state: "receive_denied" });
  write("lookup-policy.json", readGrant);
  assert.deepEqual(run(), { ...header, state: "resolved", target: { id, adapter: "claude", host } });
  write("machine.json", { host: "another-host" });
  assert.deepEqual(run(), { ...header, state: "unavailable" });
  assert.equal(fs.existsSync(path.join(dir, "receipts.sqlite")), false);
});

test("a packaged reader resolves locally and in the bounded receiver worker through one static registration", async t => {
  const { profile, dir, write } = setup(t);
  const source = fileURLToPath(new URL("./", import.meta.url));
  for (const file of fs.readdirSync(source).filter(file => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))) {
    fs.copyFileSync(path.join(source, file), path.join(dir, file));
  }
  fs.copyFileSync(path.join(source, "fixtures", "lookup-installed-readers.mjs"), path.join(dir, "installed-readers.mjs"));
  write("inventory-adapters.json", { enabled: ["sample"] });
  write("lookup-policy.json", readGrant);
  const frame = { ...request, adapter: "sample" };
  const expected = { ...header, state: "resolved", target };
  if (process.platform === "win32") {
    const cli = path.join(dir, "cli.mjs");
    assert.deepEqual(profileCli(profile, cli, ["resolve", "--id", id, "--adapter", "sample", "--json"]).target, target);
    assert.deepEqual(profileCli(profile, cli, ["receive", ...binding], JSON.stringify(frame)), expected);
  } else {
    // The POSIX production config lives under /etc. Bind only the disposable
    // config root here; use the packaged local resolver, receive and worker.
    const load = name => import(pathToFileURL(path.join(dir, name)).href);
    const { createLocalAddresses } = await load("local-address.mjs");
    const { createRemoteLookup } = await load("remote-lookup-receiver.mjs");
    const { receive } = await load("receive.mjs");
    const root = () => dir;
    assert.deepEqual((await createLocalAddresses({ root }).resolve({ id, adapter: "sample" })).target, target);
    assert.deepEqual(await receive(binding, "relay receive", Readable.from([Buffer.from(JSON.stringify(frame))]),
      3000, undefined, undefined, undefined, createRemoteLookup({ root })), expected);
  }
  const observed = fs.readFileSync(path.join(dir, "reader-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(observed, [{ worker: false, operation: "enumerate" }, { worker: true, operation: "enumerate" }]);
  assert.equal(fs.existsSync(path.join(dir, "receipts.sqlite")), false);
});
