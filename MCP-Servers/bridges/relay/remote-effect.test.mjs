import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { digest, newRequestId, requestDigest } from "./delivery-protocol.mjs";
import { createLocalAddresses } from "./local-address.mjs";
import { receive } from "./receive.mjs";
import { initializeReceipts, openReceipts } from "./receipts.mjs";
import { dispatchRemote } from "./remote-delivery.mjs";
import { effectAllowed } from "./remote-effect.mjs";

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch {}
const needsDb = { skip: DatabaseSync ? false : "node:sqlite unavailable" };
const peer = "host-a", host = "host-b", to = "--Sample:Thread/One";
const cliBinding = ["--peer", peer, "--host", host];
const sendFields = { from: null, kind: "notice", conversation: null, inReplyTo: null, re: null, message: "sample notice" };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const db = path.join(dir, "receipts.sqlite");
  await initializeReceipts(db);
  const calls = [], consumed = [], observed = [];
  let live = true;
  const options = {
    receipts: () => openReceipts(db), permit: () => true,
    resolve: async binding => live ? { ok: true, target: binding } : { ok: false, state: "missing" },
    permitsProof: () => true,
    adapters: ["first", "second"].map(kind => ({
      kind, validId: () => true, ready: () => true,
      submit(binding, text) { calls.push({ binding, text }); return { ok: true }; },
      proof: { validateId: () => true, capture(binding) { observed.push("capture"); return { id: binding.id, kind }; },
        verify(cursor, expected) {
          observed.push("verify");
          return consumed.some(row => row.binding.id === cursor.id && row.binding.adapter === cursor.kind &&
            digest(row.text) === expected) ? "delivered" : "pending";
        } },
    })),
  };
  const base = { v: 4, host, adapter: "first", to, requestId: newRequestId() };
  async function wire(request, custom = options) {
    const reply = await receive(cliBinding, "relay receive", Readable.from([Buffer.from(JSON.stringify(request))]), 500,
      undefined, (r, p) => dispatchRemote(r, p, custom));
    assert.equal(reply.ok, true);
    if (request.v === 4) {
      assert.equal(reply.adapter, request.adapter);
      assert.equal(reply.to, request.to);
    }
    return reply.state;
  }
  return { db, options, base, calls, consumed, observed, wire, endSession: () => { live = false; } };
}

test("one reservation binds the literal recipient, adapter, action, version and original bytes", needsDb, async t => {
  const f = await fixture(t), send = { ...f.base, op: "send", ...sendFields };
  const ready = { ...f.base, op: "resolve", action: "send" };
  assert.equal(await f.wire(ready), "eligible");
  const store = await openReceipts(f.db);
  try { assert.equal(store.status(peer, send.requestId), "missing"); } finally { store.close(); }
  assert.equal(await f.wire(send), "queued");
  f.endSession();
  assert.equal(await f.wire(ready), "eligible");
  assert.equal(await f.wire(send), "queued");
  assert.equal(await f.wire({ ...ready, adapter: "second" }), "request_conflict");
  assert.equal(await f.wire({ ...send, adapter: "second" }), "request_conflict");
  assert.equal(await f.wire({ ...send, message: "changed" }), "request_conflict");
  assert.equal(await f.wire({ ...f.base, op: "ping" }), "request_conflict");
  assert.equal(await f.wire({ ...f.base, op: "status", adapter: "second" }), "missing");
  assert.equal(await f.wire({ ...f.base, op: "status" }), "queued");
  assert.equal(await f.wire({ v: 2, op: "status", host, requestId: send.requestId },
    { allowed: () => true, receipts: f.options.receipts }), "missing");
  const legacy = { v: 2, op: "send", host, requestId: send.requestId, to: "legacy", ...sendFields };
  assert.equal(await f.wire(legacy, { allowed: () => true, receipts: f.options.receipts }), "request_conflict");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].binding, { host, adapter: "first", id: to });
  assert.deepEqual(f.observed, []);
});

test("cold proof uses a stored cursor only for the current granted binding and never submits", needsDb, async t => {
  const f = await fixture(t);
  assert.equal(await f.wire({ ...f.base, op: "ping" }), "pending");
  const cold = { ...f.options, adapters: f.options.adapters.map(route => ({ kind: route.kind, proof: route.proof })),
    resolve: assert.fail, capture: assert.fail, run: assert.fail };
  const status = { ...f.base, op: "status" };
  assert.equal(await f.wire(status, cold), "pending");
  f.consumed.push(f.calls[0]);
  assert.equal(await f.wire(status, cold), "delivered");
  const checks = f.observed.length;
  assert.equal(await f.wire(status, { ...cold, permit: () => false, receipts: assert.fail }), "receive_denied");
  assert.equal(await f.wire({ ...status, to: "another" }, cold), "missing");
  assert.equal(await f.wire(status, { ...cold, permitsProof: () => false }), "proof_unavailable");
  const db = new DatabaseSync(f.db);
  try { db.prepare("UPDATE proofs SET cursor=?").run(JSON.stringify({ id: to, kind: "second" })); }
  finally { db.close(); }
  assert.equal(await f.wire(status, cold), "proof_unavailable");
  assert.equal(f.observed.length, checks);
  assert.equal(f.calls.length, 1);
});

for (const disposition of ["pending", "unknown"]) test("duplicate ping returns stored " + disposition + " without rereading proof", needsDb, async t => {
  const f = await fixture(t);
  f.options.permit = (_peer, _binding, action) => action === "ping";
  if (disposition === "unknown") {
    f.options.adapters[0].submit = (binding, text) => { f.calls.push({ binding, text }); throw Error("lost response"); };
  }
  const ping = { ...f.base, op: "ping" };
  assert.equal(await f.wire(ping), disposition);
  assert.deepEqual(f.observed, disposition === "pending" ? ["capture", "verify"] : ["capture"]);
  f.consumed.push(f.calls[0]);
  const reads = f.observed.length;
  assert.equal(await f.wire({ ...ping, op: "status" }), "receive_denied");
  assert.equal(await f.wire({ v: 2, op: "status", host, requestId: ping.requestId },
    { allowed: () => true, receipts: f.options.receipts, verify: assert.fail }), "missing");
  assert.equal(await f.wire(ping), disposition);
  assert.equal(f.observed.length, reads);
  assert.equal(f.calls.length, 1);
  f.options.permit = (_peer, _binding, action) => action === "status";
  assert.equal(await f.wire({ ...ping, op: "status" }), "delivered");
  assert.equal(f.observed.length, reads + 1);
  assert.equal(f.calls.length, 1);
});

test("status withholds proof when the installed reader is disabled during verification", needsDb, async t => {
  const f = await fixture(t);
  assert.equal(await f.wire({ ...f.base, op: "ping" }), "pending");
  let enabled = true, start, release;
  const started = new Promise(resolve => { start = resolve; });
  f.options.permitsProof = () => enabled;
  f.options.adapters[0].proof.verify = async () => {
    start();
    await new Promise(resolve => { release = resolve; });
    return "delivered";
  };
  const status = f.wire({ ...f.base, op: "status" });
  await started;
  enabled = false;
  release();
  assert.equal(await status, "proof_unavailable");
  assert.equal(f.calls.length, 1);
});

for (const phase of ["admission", "preflight", "capture", "final readiness"]) {
  test("protected reader withdrawal at " + phase + " prevents an unprovable remote probe", needsDb, async t => {
    const f = await fixture(t);
    const root = path.dirname(f.db);
    fs.writeFileSync(path.join(root, "machine.json"), JSON.stringify({ host }));
    const install = enabled => fs.writeFileSync(path.join(root, "inventory-adapters.json"), JSON.stringify({ enabled }));
    const route = f.options.adapters[0];
    route.enumerate = () => ({ targets: [], complete: true });
    f.options.permitsProof = createLocalAddresses({ root: () => root, additionalAdapters: [route] }).permitsProof;
    install(phase === "admission" ? [] : [route.kind]);
    let checks = 0, captures = 0;
    route.ready = async () => {
      checks++;
      await Promise.resolve();
      if (phase === "preflight" || (phase === "final readiness" && checks === 2)) install([]);
      return true;
    };
    route.proof.capture = async () => {
      captures++;
      await Promise.resolve();
      if (phase === "capture") install([]);
      return { kind: route.kind, id: to };
    };
    const frame = phase === "preflight" ? { ...f.base, op: "resolve", action: "ping" } : { ...f.base, op: "ping" };
    const state = await f.wire(frame);
    assert.equal(f.calls.length, 0, "no provider submissions after proof authority is withdrawn");
    assert.equal(state, "proof_unavailable");
    assert.equal(captures, ["capture", "final readiness"].includes(phase) ? 1 : 0);
    assert.deepEqual(f.observed, []);
    const store = await openReceipts(f.db);
    try { assert.equal(Boolean(store.proof(peer, f.base.requestId)), phase === "final readiness"); }
    finally { store.close(); }
  });
}

test("policy is exact and rechecked around readiness, cursor capture, submission and response", needsDb, async t => {
  const f = await fixture(t);
  const dir = path.dirname(f.db);
  const save = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const grant = { peer, adapter: "first", ids: [to], ops: ["ping"] };
  const change = grants => save("effect-policy.json", { v: 1, grants });
  save("receive-policy.json", { enabled: true, codex: [] });
  f.options.permit = (origin, binding, op) => effectAllowed(origin, binding, op, dir);
  const eligible = { ...f.base, op: "resolve", action: "ping" };
  for (const grants of [[], [{ ...grant, peer: host }], [{ ...grant, adapter: "second" }],
    [{ ...grant, ids: ["another"] }], [{ ...grant, ops: ["send"] }], [{ ...grant, extra: true }]]) {
    change(grants);
    assert.equal(await f.wire(eligible, { ...f.options, receipts: assert.fail }), "receive_denied");
  }
  change([grant]);
  assert.equal(await f.wire(eligible), "eligible");
  save("receive-policy.json", { enabled: false, codex: [] });
  assert.equal(await f.wire(eligible, { ...f.options, receipts: assert.fail }), "receive_denied");
  save("receive-policy.json", { enabled: true, codex: [] });
  const route = f.options.adapters[0];
  route.ready = () => { change([]); return true; };
  assert.equal(await f.wire({ ...f.base, op: "ping" }), "receive_denied");
  assert.deepEqual(f.observed, []);
  route.ready = () => true;
  route.proof.capture = () => { change([]); return { kind: "first", id: to }; };
  change([grant]);
  assert.equal(await f.wire({ ...f.base, requestId: newRequestId(), op: "ping" }), "receive_denied");
  route.proof.capture = () => ({ kind: "first", id: to });
  route.proof.verify = () => { change([]); return "delivered"; };
  change([grant]);
  assert.equal(await f.wire({ ...f.base, requestId: newRequestId(), op: "ping" }), "receive_denied");
  assert.equal(f.calls.length, 1);
});

test("receipt recovery after an uncertain or concurrent effect cannot resubmit it", needsDb, async t => {
  const f = await fixture(t);
  const send = { ...f.base, op: "send", ...sendFields };
  let start, release;
  const started = new Promise(r => { start = r; });
  let submissions = 0;
  f.options.adapters[0].submit = async () => {
    submissions++; start(); await new Promise(r => { release = r; }); throw new Error("fixture");
  };
  const first = f.wire(send);
  await started;
  assert.equal(await f.wire(send), "unknown");
  release();
  assert.equal(await first, "unknown");
  assert.equal(await f.wire({ ...f.base, op: "status" }), "unknown");
  assert.equal(await f.wire(send), "unknown");
  assert.equal(submissions, 1);
});

test("only legacy probe evidence matching both the digest and native cursor can serve a bound status grant", needsDb, async t => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000001";
  const status = { ...f.base, adapter: "codex", to: id, op: "status" };
  const store = await openReceipts(f.db);
  try {
    const hash = requestDigest({ v: 2, op: "ping", host, to: id });
    store.reserve(peer, status.requestId, hash, Date.now());
    store.saveProof(peer, status.requestId, { kind: "codex", id }, digest("test"));
    store.finish(peer, status.requestId, hash, "pending");
  } finally { store.close(); }
  f.options.verify = () => "delivered";
  assert.equal(await f.wire(status), "delivered");
  assert.equal(await f.wire({ ...status, adapter: "first" }), "missing");
  assert.equal(await f.wire({ ...status, to: "00000000-0000-4000-8000-000000000002" }), "missing");
  assert.equal(await f.wire({ ...status, op: "resolve", action: "ping" }), "request_conflict");
  assert.equal(await f.wire({ ...status, op: "ping" }), "request_conflict");
  const db = new DatabaseSync(f.db);
  try { db.prepare("UPDATE receipts SET digest=?,state='queued'").run(requestDigest({ v: 2, op: "send", host, to: id, ...sendFields })); }
  finally { db.close(); }
  assert.equal(await f.wire(status), "missing");
  assert.equal(f.calls.length, 0);
});

test("malformed or unregistered routes cannot disclose private diagnostics or spawn a provider", needsDb, async t => {
  const f = await fixture(t);
  const base = { ...f.base, op: "resolve", action: "send" };
  for (const request of [{ ...base, extra: true }, { ...base, message: "body" }, { ...base, action: "lookup" },
    { ...base, to: "broken\nline" }, { ...base, adapter: "Bad key" }]) {
    const reply = await receive(cliBinding, "relay receive", Readable.from([Buffer.from(JSON.stringify(request))]),
      500, undefined, assert.fail);
    assert.deepEqual(reply, { ok: false, error: "invalid_frame" });
  }
  for (const adapter of ["claude", "unregistered"]) assert.equal(await f.wire({ ...base, adapter }), "restricted_route");
  assert.equal(await f.wire({ ...base, adapter: "codex" }), "unaddressable");
  const reply = await receive(cliBinding, "relay receive", Readable.from([Buffer.from(JSON.stringify(base))]),
    500, undefined, () => ({ diagnostic: "private output" }));
  assert.equal(reply.state, "unavailable");
  assert.deepEqual(f.calls, []);
});

test("bound native probes repeat the queue and selection barriers after cursor capture", needsDb, async t => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000001";
  let captures = 0, checks = 0, runs = 0;
  const target = { host, adapter: "codex", id };
  const ping = { ...f.base, op: "ping", adapter: target.adapter, to: target.id };
  Object.assign(f.options, {
    available: () => true,
    resolve: async (selector, opts) => {
      assert.deepEqual(selector, target);
      assert.equal(opts.requireCodexEligibility, true);
      return { ok: true, target };
    },
    check: async (recipient, { checkBinding }) => {
      assert.equal(recipient, id);
      assert.equal(await checkBinding(), null);
      return ++checks === 2 ? { cause: "target_disappeared" } : null;
    },
    capture: ({ kind, id }) => { captures++; return { kind, id }; },
    verify: assert.fail,
    run: () => { runs++; return "queued"; },
  });
  assert.equal(await f.wire(ping), "unaddressable");
  assert.deepEqual([captures, checks, runs], [1, 2, 0]);
  assert.equal(await f.wire({ ...ping, op: "status" }), "unaddressable");
  f.options.verify = () => "delivered";
  assert.equal(await f.wire({ ...ping, requestId: newRequestId() }), "delivered");
  assert.deepEqual([captures, checks, runs], [2, 4, 1]);
});
