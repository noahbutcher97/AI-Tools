import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sendAddressed, sendStatus } from "./addressed-send.mjs";
import { newRequestId, parseAddress } from "./delivery-protocol.mjs";
import { receive } from "./receive.mjs";
import { dispatchRemote } from "./remote-delivery.mjs";
import { initializeReceipts, openReceipts } from "./receipts.mjs";

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
  const adapters = {
    allowed: (peer, to) => peer === "host-a" && (to === null || to === id),
    list: async () => ({ targets: [target], partial: false }),
    available: () => true, check: async () => null, receipts: () => openReceipts(file),
    reference: async () => ({ ok: true, excerpt: "quoted\ntext", truncated: false }),
    run: async (to, text) => { calls.push({ to, text }); return "queued"; },
  };
  const api = { directory, query: async (entry, frame) => {
    frames.push(frame);
    return { reply: await receive(binding, "relay receive", input(frame), 500, undefined,
      (request, peer) => dispatchRemote(request, peer, adapters)) };
  }, local: () => assert.fail("unexpected local fallback") };
  return { file, calls, frames, adapters, target, api };
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

test("resolve transmits no body, fetches no quotes, opens no receipt store and never dispatches", async t => {
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

test("a correlated send uses only the key-bound host and structured data, and status never resends", async t => {
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

test("concurrent and uncertain submissions consume a single durable reservation", async t => {
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

test("malformed fields, peer overrides and stale or mismatched frames cannot dispatch", async t => {
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

test("a restricted receive CLI with no grants denies even a well-formed delivery", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = { v: 2, host: "host-b", op: "send", to: id, requestId: newRequestId(),
    from: null, message: "fixture", kind: "notice", conversation: null, inReplyTo: null, re: null };
  const cli = fileURLToPath(new URL("cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "receive", ...binding], { input: JSON.stringify(request),
    encoding: "utf8", env: { ...process.env, ProgramFiles: root, SSH_ORIGINAL_COMMAND: "relay receive" } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).state, "receive_denied");
  assert.doesNotMatch(result.stdout, /fixture/);
  assert.deepEqual(fs.readdirSync(root), []);
});
