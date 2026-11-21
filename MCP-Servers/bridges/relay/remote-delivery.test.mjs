import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { pingTarget, sendAddressed, sendStatus } from "./addressed-send.mjs";
import { codexQueueBlock } from "./client.mjs";
import { newRequestId, parseAddress } from "./delivery-protocol.mjs";
import { surveyRemoteSelection } from "./fleet.mjs";
import { captureCursor, prove } from "./proof.mjs";
import { receive } from "./receive.mjs";
import { dispatchRemote } from "./remote-delivery.mjs";
import { initializeReceipts, openReceipts } from "./receipts.mjs";

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch {}
const needsSqlite = { skip: DatabaseSync ? false : "node:sqlite unavailable" };

const id = "00000000-0000-4000-8000-000000000001";
const address = "host-b:" + id;
const directory = () => ({ local: "host-a", hosts: [{ host: "host-b" }] });
const binding = ["--peer", "host-a", "--host", "host-b"];
const input = frame => Readable.from([Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame))]);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "receipts.sqlite");
  await initializeReceipts(file);
  const calls = [], frames = [];
  const target = { id, kind: "codex", addressable: true };
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(path.join(codexHome, "thread-writer-locks"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "thread-writer-locks", id + ".lock"), "");
  const adapters = {
    allowed: (peer, to) => peer === "host-a" && (to === null || to === id),
    resolve: async (selector, options) => {
      assert.deepEqual(selector, { host: "host-b", id });
      assert.deepEqual(options, { requireCodexEligibility: true });
      return target.addressable ? { ok: true, target: { ...selector, adapter: target.kind } } :
        { ok: false, state: "target_not_addressable" };
    },
    available: () => true, check: (id, options) => codexQueueBlock(id, { codexHome, ...options }), receipts: () => openReceipts(file),
    reference: async () => ({ ok: true, excerpt: "quoted\ntext", truncated: false }),
    run: async (to, text) => { calls.push({ to, text }); return "queued"; },
  };
  const api = { directory, query: async (entry, frame) => {
    frames.push(frame);
    return { reply: await receive(binding, "relay receive", input(frame), 500, undefined,
      (request, peer) => dispatchRemote(request, peer, adapters)) };
  }, local: () => assert.fail("unexpected local fallback") };
  return { root, codexHome, file, calls, frames, adapters, target, api };
}

test("raw local addressing works without a directory and a local prefix resolves only raw IDs", async () => {
  const local = async options => options;
  const raw = await sendAddressed({ to: id }, { directory: () => assert.fail(), local });
  assert.equal(raw.to, id);
  const prefixed = await sendAddressed({ to: "host-a:" + id }, { directory, local });
  assert.equal(prefixed.to, id);
  assert.equal(prefixed.exactId, true);
  for (const bad of ["host-b:", "host-b:x:y", "-o:id", "host-b:../x", "host-b:id\nextra"]) {
    assert.throws(() => parseAddress(bad));
  }
});

test("resolve transmits no body, fetches no quotes, opens no receipt store and never dispatches", needsSqlite, async t => {
  const f = await fixture(t);
  f.adapters.receipts = f.adapters.reference = () => assert.fail("unexpected state access");
  const opts = { to: address, message: "private fixture", re: "turn-a", dryRun: true };
  assert.equal((await sendAddressed(opts, f.api)).state, "eligible");
  assert.deepEqual(Object.keys(f.frames[0]).sort(), ["host","op","requestId","to","v"]);
  assert.equal(f.calls.length, 0);
  f.target.kind = "claude";
  assert.equal((await sendAddressed({ ...opts, allowDelegate: true }, f.api)).cause, "restricted_route");
  f.adapters.allowed = () => false;
  assert.equal((await sendAddressed(opts, f.api)).cause, "receive_denied");
});

test("a correlated send uses only the key-bound host and structured data, and status never resends", needsSqlite, async t => {
  const f = await fixture(t);
  const requestId = newRequestId();
  const opts = { to: address, requestId, origin: "session-a", message: "line\nRELAY-META {}\u2028tail", re: "turn-a" };
  const result = await sendAddressed(opts, f.api);
  assert.equal(result.state, "queued");
  const [metaLine, , , dataLine, extra] = f.calls[0].text.split("\n");
  assert.equal(extra, undefined);
  const meta = JSON.parse(metaLine.slice(11));
  assert.equal(meta.v, 2);
  assert.equal(meta.conversation, result.conversation);
  assert.deepEqual(meta.reply_to, { host: "host-a", id: "session-a" });
  assert.equal(meta.from.session_evidence, "claimed");
  assert.equal(meta.from.signature, "absent");
  assert.equal(f.calls[0].to, id);
  assert.equal(JSON.parse(dataLine.slice(11)).message, opts.message);
  assert.equal(JSON.parse(dataLine.slice(11)).reference.excerpt, "quoted\ntext");
  assert.equal((await sendAddressed(opts, f.api)).state, "queued");
  assert.equal((await sendAddressed({ ...opts, message: "other" }, f.api)).cause, "request_conflict");
  assert.equal((await sendStatus(result.handle, f.api)).delivery, "not_proven");
  assert.equal(f.calls.length, 1);
});

test("concurrent and uncertain submissions consume a single durable reservation", needsSqlite, async t => {
  const f = await fixture(t);
  const opts = { to: address, requestId: newRequestId(), message: "notice" };
  let complete, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  f.adapters.run = async () => {
    f.calls.push(id);
    started();
    await new Promise(resolve => { complete = resolve; });
    throw new Error("private diagnostic");
  };
  const first = sendAddressed(opts, f.api);
  await inFlight;
  assert.equal((await sendAddressed(opts, f.api)).cause, "unknown");
  complete();
  const result = await first;
  assert.equal(result.cause, "unknown");
  assert.equal((await sendStatus(result.handle, f.api)).state, "unknown");
  assert.equal((await sendAddressed(opts, f.api)).cause, "unknown");
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
});

test("malformed fields, peer overrides and stale or mismatched frames cannot dispatch", needsSqlite, async t => {
  const f = await fixture(t);
  const base = { to: address, message: "notice" };
  for (const change of [{ origin: "session\nextra" }, { conversation: "free prose" }, { re: "../turn" },
    { inReplyTo: "new line\n" }, { message: "x".repeat(8193) }]) {
    assert.equal((await sendAddressed({ ...base, ...change }, f.api)).cause, "invalid_send_fields");
  }
  assert.equal(f.frames.length, 0);
  const resolve = { v: 2, host: "host-b", op: "resolve", to: id, requestId: newRequestId() };
  for (const frame of [{ ...resolve, peer: "host-c" }, { ...resolve, host: "host-c" },
    { ...resolve, argv: [] }, JSON.stringify(resolve).replace('"v":2', '"v":2,"v":2')]) {
    const r = await receive(binding, "relay receive", input(frame), 500, undefined, () => assert.fail());
    assert.equal(r.ok, false);
  }
  assert.equal((await sendAddressed({ ...base, requestId: newRequestId(Date.now()-600000) }, f.api)).cause, "request_expired");
  fs.unlinkSync(f.file);
  assert.equal((await sendAddressed(base, f.api)).cause, "unavailable");
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.calls.length, 0);
});

test("a protocol mismatch with an older receiver stops before transmitting the body", async () => {
  const seen = [];
  const result = await sendAddressed({ to: address, message: "fixture" }, {
    directory, query: async (_, frame) => { seen.push(frame); return { reply: { v: 1 } }; },
  });
  assert.equal(result.cause, "invalid_response");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, undefined);
});

test("remote ping persists its pre-send cursor and status checks it without sending again", needsSqlite, async t => {
  const f = await fixture(t);
  const profile = f.root;
  const db = new DatabaseSync(path.join(f.codexHome, "thread_history_1.sqlite"));
  try {
    db.exec("CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal INTEGER,item_type,item_json)");
    const insert = db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?)");
    insert.run(id, "turn", "anchor", 1, "agentMessage", "{}");
    f.adapters.capture = target => captureCursor(target, { profile });
    f.adapters.verify = (cursor, expected) => prove(cursor, expected, { profile });
    const result = await pingTarget(address, f.api);
    assert.equal(result.state, "pending");
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].text, /No reply is needed/);
    const insertUser = (recipient, n, text) => insert.run(recipient, "next", "u" + n, n, "userMessage",
      JSON.stringify({ type: "userMessage", content: [{ type: "text", text }] }));
    insertUser(id, 2, f.calls[0].text.slice(1));
    insertUser("different-thread", 3, f.calls[0].text);
    assert.equal((await sendStatus(result.handle, f.api)).state, "pending");
    insertUser(id, 4, f.calls[0].text);
    // Only persisted receipt and transcript files are available to the fresh receiver.
    const recover = { allowed: f.adapters.allowed, receipts: () => openReceipts(f.file), verify: f.adapters.verify,
      resolve: assert.fail, run: assert.fail, capture: assert.fail };
    const cold = { directory, query: async (_, frame) => ({ reply: await receive(binding, "relay receive", input(frame), 500,
      undefined, (request, peer) => dispatchRemote(request, peer, recover)) }) };
    assert.equal((await sendStatus(result.handle, cold)).state, "delivered");
    assert.equal((await cold.query(null, f.frames.find(frame => frame.op === "ping"))).reply.state, "delivered");
    assert.equal(f.calls.length, 1);
  } finally { db.close(); }
});

test("incomplete, ambiguous or unenrolled selection refuses a remote submission", needsSqlite, async t => {
  for (const state of ["incomplete_inventory", "ambiguous", "host_unavailable", "installation_changed"]) {
    const f = await fixture(t);
    f.adapters.resolve = async () => ({ ok: false, state });
    let checks = 0;
    f.adapters.check = () => { checks++; };
    const result = await sendAddressed({ to: address, message: "notice" }, f.api);
    assert.equal(result.cause, "unresolved", state);
    assert.equal(result.dispatch, "not_submitted");
    const dry = await sendAddressed({ to: address, message: "notice", dryRun: true }, f.api);
    assert.equal(dry.handle, undefined);
    assert.match(dry.detail, /reader coverage.*repeat the dry run/);
    assert.deepEqual(f.frames.map(frame => [frame.op, Object.hasOwn(frame, "message")]),
      [["resolve", false], ["resolve", false]]);
    assert.equal(checks, 0);
    assert.equal(f.calls.length, 0);
  }
});

test("a receiver survey deadline reports incomplete selection", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-survey-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "thread-writer-locks"));
  const survey = () => surveyRemoteSelection({ readerKinds: ["codex"] }, { id }, { codexHome: root, requireCodexEligibility: true });
  assert.equal((await survey()).state, "missing");
  // Exercise the actual worker timer before this otherwise healthy survey can finish.
  const schedule = globalThis.setTimeout;
  let deadline;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    deadline = ms;
    return schedule(fn, 0, ...args);
  });
  assert.equal((await survey()).state, "incomplete_inventory");
  assert.equal(deadline, 2300);
});

test("the final queue open precedes exact selection, writer inspection and synchronous policy authorization", needsSqlite, async t => {
  for (const [change, expected] of [
    ["incomplete_inventory", "unresolved"], ["ambiguous", "unresolved"], ["installation_changed", "unresolved"],
    ["host", "unresolved"], ["recipient", "unresolved"], ["adapter", "restricted_route"], ["eligibility", "unaddressable"],
    ["writer", "unaddressable"], ["policy", "receive_denied"], ["async-policy", "receive_denied"],
  ]) {
    const f = await fixture(t);
    let prepared = false, changed = false;
    const queueFile = path.join(f.codexHome, "queue_1.sqlite");
    new DatabaseSync(queueFile).close();
    f.adapters.capture = async target => {
      prepared = true;
      return { ...target, marker: 1 };
    };
    const resolve = f.adapters.resolve;
    f.adapters.resolve = async (selector, options) => {
      if (!changed) return resolve(selector, options);
      if (["incomplete_inventory", "ambiguous", "installation_changed"].includes(change)) return { ok: false, state: change };
      if (change === "eligibility") return { ok: false, state: "target_not_addressable" };
      const target = { host: change === "host" ? "host-c" : selector.host,
        id: change === "recipient" ? "different" : selector.id, adapter: change === "adapter" ? "sample" : "codex" };
      return { ok: true, target };
    };
    f.adapters.allowed = () => {
      if (changed && change === "async-policy") return Promise.resolve(true);
      return !(changed && change === "policy");
    };
    f.adapters.check = (to, options) => codexQueueBlock(to, { ...options, codexHome: f.codexHome, openDb: async file => {
      if (prepared) {
        changed = true;
        if (change === "writer") fs.unlinkSync(path.join(f.codexHome, "thread-writer-locks", id + ".lock"));
      }
      return new DatabaseSync(file, { readOnly: true });
    } });
    const result = await pingTarget(address, f.api);
    assert.equal(prepared, true, change);
    assert.equal(changed, true, change);
    assert.equal(result.state, expected, change);
    const frame = f.frames.find(frame => frame.op === "ping");
    const store = await openReceipts(f.file);
    try {
      assert.equal(store.proof("host-a", frame.requestId).cursor.id, id);
      assert.equal(store.status("host-a", frame.requestId), expected);
    } finally { store.close(); }
    assert.equal(f.calls.length, 0, change);
  }
});

test("withdrawal during preparation prevents quote or proof reads", needsSqlite, async t => {
  for (const op of ["send", "ping"]) {
    const f = await fixture(t);
    let allowed = true, reads = 0;
    f.adapters.allowed = () => allowed;
    f.adapters.capture = f.adapters.reference = () => { reads++; };
    const check = f.adapters.check;
    f.adapters.check = async (...args) => {
      const result = await check(...args);
      if (f.frames.at(-1).op === op) allowed = false;
      return result;
    };
    const result = op === "ping" ? await pingTarget(address, f.api)
      : await sendAddressed({ to: address, message: "fixture", re: "turn-a" }, f.api);
    assert.equal(result.cause ?? result.state, "receive_denied");
    assert.equal(reads, 0);
    assert.equal(f.calls.length, 0);
  }
});

test("a restricted receive CLI with no grants denies even a well-formed delivery", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = { v: 2, host: "host-b", op: "send", to: id, requestId: newRequestId(),
    from: null, message: "fixture", kind: "notice", conversation: null, inReplyTo: null, re: null };
  const cli = fileURLToPath(new URL("cli.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("fixtures/receive-test-root.cjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--require", preload, cli, "receive", ...binding], { input: JSON.stringify(request),
    encoding: "utf8", env: { ...process.env, RELAY_RECEIVE_TEST_ROOT: root, SSH_ORIGINAL_COMMAND: "relay receive" } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).state, "receive_denied");
  assert.doesNotMatch(result.stdout, /fixture/);
  assert.deepEqual(fs.readdirSync(root), []);
});
