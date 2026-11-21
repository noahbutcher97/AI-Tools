import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoundDelivery } from "./bound-delivery.mjs";
import { digest } from "./delivery-protocol.mjs";
import { localPing, localStatus, pingBound } from "./local-ping.mjs";

const binding = { host: "host-a", adapter: "sample", id: "--Case:A/B" };
const codexId = "00000000-0000-4000-8000-000000000001";
function profileDir(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bound-proof-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return profile;
}

function sampleHistory() {
  const rows = [], submissions = [];
  const proofAdapters = new Map([["sample", {
    validateId: id => id === binding.id,
    capture: target => ({ kind: target.adapter, id: target.id, offset: rows.length }),
    verify: (cursor, expected, { binding: target }) => rows.slice(cursor.offset).some(row =>
      row.id === target.id && row.adapter === target.adapter && row.host === target.host &&
      row.role === "user" && digest(row.text) === expected) ? "delivered" : "pending",
  }]]);
  const route = { kind: "sample", validId: id => id === binding.id, ready: () => true, submit(target, text) {
    assert.deepEqual(target, binding);
    submissions.push(text);
    return { ok: true };
  } };
  const sendBound = createBoundDelivery({ resolve: () => ({ ok: true, target: binding }), adapters: [route] });
  return { rows, submissions, proofAdapters, sendBound };
}

test("a bound non-UUID receipt proves only the exact consumed envelope and survives a fresh lookup without resending", async t => {
  const profile = profileDir(t);
  const { rows, submissions, proofAdapters, sendBound } = sampleHistory();
  let reserved;
  const result = await pingBound(binding, { profile, proofAdapters, sendBound, waitMs: 0,
    onHandle: handle => { reserved = handle; assert.equal(submissions.length, 0); } });
  assert.equal(result.state, "pending");
  assert.equal(result.dispatch, "accepted");
  assert.deepEqual(result.binding, binding);
  assert.equal(result.handle, reserved);
  assert.equal(submissions.length, 1);
  const row = { ...binding, text: submissions[0], role: "user" };
  rows.push({ ...row, text: row.text.slice(1) }, { ...row, id: binding.id.toLowerCase() }, { ...row, role: "assistant" },
    { ...row, adapter: "other" }, { ...row, host: "host-b" });
  assert.equal((await localStatus(reserved, { profile, proofAdapters })).state, "pending");
  rows.push(row);
  assert.equal((await localStatus(reserved, { profile })).state, "proof_unavailable");
  const delivered = await localStatus(reserved, { profile, proofAdapters });
  assert.equal(delivered.state, "delivered");
  assert.deepEqual(delivered.binding, binding);
  assert.equal(submissions.length, 1);
});

test("unsupported proof, an invalid native ID, a changed target, or a mismatched serialized cursor prevent submission", async t => {
  const profile = profileDir(t);
  for (const [scenario, change, selected] of [
    ["missing adapter", undefined],
    ["missing verify", { verify: undefined }],
    ["provider ID rule", { validateId: () => false }],
    ["capture error", { capture: () => { throw new Error("private-provider-marker"); } }],
    ["wrong ID", { capture: () => ({ kind: "sample", id: binding.id.toLowerCase() }) }],
    ["wrong adapter", { capture: () => ({ kind: "other", id: binding.id }) }],
    ["wrong serialization", { capture: () => ({ kind: "sample", id: binding.id, toJSON: () => ({}) }) }],
    ["wrong host", {}, { ...binding, host: "host-b" }],
    ["oversized cursor", { capture: () => ({ kind: "sample", id: binding.id, data: "x".repeat(8192) }) }],
  ]) {
    const { proofAdapters } = sampleHistory();
    if (change) Object.assign(proofAdapters.get("sample"), change);
    else proofAdapters.clear();
    let submits = 0, handles = 0;
    const result = await pingBound(binding, { profile, proofAdapters, waitMs: 0, onHandle: () => { handles++; },
      sendBound: async (selector, { beforeSubmit }) => {
        await beforeSubmit(selected ?? binding, "fixture envelope");
        submits++;
        return { ok: true };
      } });
    assert.equal(result.cause, "proof_unavailable", scenario);
    assert.equal(result.dispatch, "not_submitted", scenario);
    assert.equal(submits, 0, scenario);
    assert.equal(handles, 0, scenario);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-marker/);
  }
});

test("a final selection refusal after reservation is definite and a lost acknowledgement remains checkable", async t => {
  const profile = profileDir(t);
  const { proofAdapters } = sampleHistory();
  let probes = 0, handles = 0;
  const base = { profile, proofAdapters, waitMs: 0, onHandle: () => { handles++; }, expectedBinding: binding };
  const route = { kind: "sample", validId: () => true, ready: () => true, submit: () => { probes++; return { ok: true }; } };
  const refuseAfterCapture = createBoundDelivery({ adapters: [route], resolve: () => handles ?
    { ok: false, state: "missing" } : { ok: true, target: binding } });
  const refused = await pingBound(binding, { ...base, sendBound: refuseAfterCapture });
  assert.equal(handles, 1);
  assert.equal(refused.state, "dispatch_failed");
  assert.equal(refused.cause, "missing");
  assert.equal(refused.dispatch, "not_submitted");
  assert.equal(refused.handle, undefined);
  assert.equal(probes, 0);
  const uncertain = await pingBound(binding, { ...base, sendBound: async (selector, options) => {
    await options.beforeSubmit(binding, options.message);
    probes++;
    throw new Error("private-provider-marker");
  } });
  assert.equal(uncertain.state, "pending");
  assert.equal(uncertain.dispatch, "unknown");
  assert.equal((await localStatus(uncertain.handle, { profile, proofAdapters })).state, "pending");
  assert.doesNotMatch(JSON.stringify(uncertain), /private-provider-marker/);
  assert.equal(probes, 1);
});

test("current installation permission is required before capture and each bound proof lookup", async t => {
  const profile = profileDir(t), fixture = sampleHistory();
  let enabled = false, captures = 0, reads = 0;
  const checkProofBinding = async target => {
    assert.deepEqual(target, binding);
    return enabled;
  };
  Object.assign(fixture.proofAdapters.get("sample"), {
    capture: target => { captures++; return { kind: target.adapter, id: target.id }; },
    verify: () => { reads++; return "pending"; },
  });
  const options = { ...fixture, profile, waitMs: 0, checkProofBinding };
  assert.equal((await pingBound(binding, options)).dispatch, "not_submitted");
  assert.equal(captures, 0);
  assert.equal(fixture.submissions.length, 0);
  enabled = true;
  const result = await pingBound(binding, { ...options, onHandle: () => { enabled = false; } });
  assert.equal(result.dispatch, "accepted");
  assert.equal(result.state, "proof_unavailable");
  assert.equal(captures, 1);
  assert.equal((await localStatus(result.handle, options)).state, "proof_unavailable");
  assert.equal(reads, 0);
  enabled = true;
  assert.equal((await localStatus(result.handle, options)).state, "pending");
  assert.equal(reads, 1);
  assert.equal(fixture.submissions.length, 1);
});

// Produce authenticated historical and malformed records independently from the writer.
function fixtureHandle(profile, record) {
  const prefix = "local-proof.", iv = randomBytes(12);
  const key = fs.readFileSync(path.join(profile, ".cross-agent-relay", "proof.key"));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(prefix));
  const data = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

test("status rejects authenticated format and target confusion before a reader opens any transcript", async t => {
  const profile = profileDir(t);
  fs.mkdirSync(path.join(profile, ".cross-agent-relay"));
  fs.writeFileSync(path.join(profile, ".cross-agent-relay", "proof.key"), randomBytes(32));
  let reads = 0, legacyReads = 0;
  const { proofAdapters } = sampleHistory();
  const reader = proofAdapters.get("sample");
  reader.verify = () => { reads++; return "delivered"; };
  const options = { profile, proofAdapters, verify: () => { legacyReads++; return "delivered"; } };
  const cursor = { kind: "sample", id: binding.id };
  const record = { v: 2, binding, expected: digest("expected"), cursor };
  for (const patch of [{ v: 3 }, { v: undefined }, { expected: "not-a-digest" },
    { cursor: { ...cursor, kind: "codex" } }, { cursor: { ...cursor, id: codexId } },
    { cursor: { ...cursor, host: "host-b" } }, { binding: { ...binding, id: "Other" } },
    { binding: { ...binding, adapter: "missing" } }, { binding: { ...binding, adapter: "codex" } }]) {
    const result = await localStatus(fixtureHandle(profile, { ...record, ...patch }), options);
    assert.equal(result.state, "proof_unavailable");
  }
  assert.equal(reads, 0);
  assert.equal(legacyReads, 0);
  assert.equal((await localStatus(fixtureHandle(profile, { cursor: { kind: "claude", id: codexId },
    expected: record.expected }), options)).state, "delivered");
  assert.equal(legacyReads, 1);
  reader.verify = () => "private-provider-marker";
  const invalid = await localStatus(fixtureHandle(profile, record), options);
  assert.equal(invalid.state, "proof_unavailable");
  assert.doesNotMatch(JSON.stringify(invalid), /private-provider-marker/);
});

test("the installed Codex proof reader observes a consumed SQLite userMessage in the bound UUID thread", async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return t.skip("node:sqlite unavailable"); }
  const profile = profileDir(t), dir = path.join(profile, ".codex");
  fs.mkdirSync(dir);
  const target = { host: null, adapter: "codex", id: codexId };
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  try {
    db.exec("CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal INTEGER,item_type,item_json)");
    const insert = db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?)");
    insert.run(codexId, "turn", "anchor", 1, "agentMessage", "{}");
    let notice;
    const result = await pingBound({ adapter: "codex", id: codexId }, { profile, waitMs: 0,
      sendBound: async (selector, options) => {
        notice = "exact fixture envelope\n" + options.message;
        await options.beforeSubmit(target, notice);
        return { ok: true };
      } });
    assert.equal(result.state, "pending");
    insert.run(codexId, "next", "user", 2, "userMessage", JSON.stringify({ type: "userMessage",
      clientId: "unrelated-queue-id", content: [{ type: "text", text: notice }] }));
    const status = await localStatus(result.handle, { profile });
    assert.equal(status.state, "delivered");
    assert.deepEqual(status.binding, target);
  } finally { db.close(); }
});

test("positional local ping forwards its selection guard and reports a final pre-effect refusal", async t => {
  const profile = profileDir(t);
  const checkLocalBinding = () => false;
  let handles = 0;
  const result = await localPing(codexId, { profile, checkLocalBinding, waitMs: 0, onHandle: () => { handles++; },
    capture: target => ({ kind: target.kind, id: target.id }), send: async options => {
      assert.equal(options.checkLocalBinding, checkLocalBinding);
      await options.beforeSubmit({ kind: "codex", id: codexId }, options.message);
      return { ok: false, cause: "binding_changed", dispatch: "not_submitted" };
    } });
  assert.equal(handles, 1);
  assert.equal(result.state, "dispatch_failed");
  assert.equal(result.dispatch, "not_submitted");
});
