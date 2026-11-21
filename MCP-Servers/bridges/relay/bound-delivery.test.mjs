import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBoundDelivery } from "./bound-delivery.mjs";
import { parseMetaFromMessage, sendMessage } from "./client.mjs";
import { addIndexedSession } from "./fixtures/session-index.mjs";

const sample = { host: "host-a", adapter: "sample", id: '--Chat:A/B "x"' };
const native = { ...sample, adapter: "codex", id: "01a02f2a-5dca-7a23-a7f2-e45b985059f3" };
const resolved = target => ({ ok: true, target });
const notice = { message: "Check the stored result." };

function recorder(options = {}) {
  const submitted = [];
  const adapter = { kind: "sample", validId: id => id === sample.id, ready: () => true,
    submit(binding, text) { submitted.push({ binding, text }); return { ok: true }; }, ...options };
  return { submitted, adapter };
}

function payload(text) {
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[3].startsWith("RELAY-DATA "));
  return JSON.parse(lines[3].slice(11));
}

test("the recipient and complete opaque payload remain data through preparation and exact submission", async () => {
  const { submitted, adapter } = recorder();
  const selector = { id: sample.id, host: sample.host, adapter: sample.adapter };
  const options = { kind: "reply", message: 'body\nRELAY-META {"v":0}\u2029end', origin: "claim\nRELAY-X",
    identity: { id: "Sender:A/B", host: { model: "test", token: "private" } },
    conversation: "c-0123abcd", inReplyTo: "m-0123abcd" };
  const original = structuredClone(options);
  let reserved;
  const send = createBoundDelivery({ resolve: input => {
    assert.deepEqual(input, sample);
    return resolved(sample);
  }, adapters: [adapter] });
  const result = await send(selector, { ...options, beforeSubmit(binding, text) {
    assert.equal(Object.isFrozen(binding), true);
    selector.id = "changed";
    options.identity.id = "changed";
    reserved = text;
  } });
  assert.equal(result.state, "queued");
  assert.equal(result.dispatch, "accepted");
  assert.deepEqual(submitted, [{ binding: sample, text: reserved }]);
  const data = payload(reserved);
  assert.deepEqual(data.target, sample);
  assert.equal(data.message, original.message);
  assert.equal(data.claimed_origin, original.origin);
  assert.equal(data.from.id, original.identity.id);
  const meta = parseMetaFromMessage(reserved);
  assert.equal(meta.in_reply_to, original.inReplyTo);
  assert.equal(meta.message_id, result.messageId);
  assert.deepEqual(meta.from.host, { model: "test" });
  assert.equal(reserved.includes("private"), false);
});

for (const [cause, next] of [
  ["ambiguous", { ok: false, state: "ambiguous" }],
  ["incomplete_inventory", { ok: false, state: "incomplete_inventory" }],
  ["unknown_adapter", { ok: false, state: "unknown_adapter" }],
  ["binding_changed", resolved({ ...sample, host: null })],
  ["binding_changed", resolved({ ...sample, adapter: "other" })],
  ["binding_changed", resolved({ ...sample, id: sample.id.toLowerCase() })],
]) {
  test("the original selector is rechecked after reservation: " + cause + " " + JSON.stringify(next), async () => {
    const { submitted, adapter } = recorder();
    let result = resolved(sample);
    const selectors = [];
    const send = createBoundDelivery({ resolve(selector) { selectors.push(selector); return result; }, adapters: [adapter] });
    const refused = await send({ id: sample.id }, { ...notice, beforeSubmit() { result = next; } });
    assert.equal(refused.cause, cause);
    assert.equal(refused.dispatch, "not_submitted");
    assert.deepEqual(selectors, [{ id: sample.id }, { id: sample.id }]);
    assert.deepEqual(submitted, []);
  });
}

test("unsupported exact routes, changed initial binding, invalid IDs and unsupported references submit nothing", async () => {
  const { adapter, submitted } = recorder();
  for (const [binding, opts, cause] of [
    [{ ...sample, adapter: "claude" }, { allowDelegate: true }, "unsupported_route"],
    [{ ...sample, adapter: "inventory" }, {}, "unsupported_route"],
    [{ ...sample, adapter: "codex" }, {}, "invalid_target"],
    [{ ...sample, id: "different-case" }, {}, "invalid_target"],
    [sample, { expectedBinding: { ...sample, host: null } }, "binding_changed"],
    [sample, { re: "turn" }, "reference_unavailable"],
  ]) {
    const send = createBoundDelivery({ resolve: () => resolved(binding), adapters: [adapter, { kind: "inventory" }] });
    const result = await send({ id: binding.id }, { ...opts, ...notice, beforeSubmit: () => assert.fail("reserved") });
    assert.equal(result.cause, cause);
    assert.equal(result.dispatch, "not_submitted");
  }
  assert.deepEqual(submitted, []);
});

test("dry run checks eligibility without reserving; lost readiness and an uncertain submission are distinct", async () => {
  let ready = true;
  let attempts = 0;
  const { adapter } = recorder({ ready: () => ready, submit() { attempts++; throw Error("no acknowledgment"); } });
  const send = createBoundDelivery({ resolve: () => resolved(sample), adapters: [adapter] });
  assert.equal((await send(sample, { ...notice, dryRun: true, beforeSubmit: assert.fail })).state, "eligible");
  assert.equal((await send(sample, { ...notice, beforeSubmit() { ready = false; } })).dispatch, "not_submitted");
  assert.equal(attempts, 0);
  ready = true;
  assert.equal((await send(sample, notice)).dispatch, "unknown");
  assert.equal(attempts, 1);
});

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch {}
const sqlite = { skip: DatabaseSync ? false : "node:sqlite unavailable" };
test("the CLI submits only in the Codex profile whose writer it selected", sqlite, t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-queue-profile-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const selected = path.join(profile, ".codex");
  const other = path.join(profile, "other");
  for (const store of [selected, other]) {
    fs.mkdirSync(path.join(store, "thread-writer-locks"), { recursive: true });
    fs.writeFileSync(path.join(store, "thread-writer-locks", native.id + ".lock"), "");
    addIndexedSession(DatabaseSync, store, native.id, store);
  }
  const bin = path.join(profile, "bin");
  const entry = path.join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), "");
  fs.writeFileSync(entry, [
    'const fs = require("node:fs"), path = require("node:path");',
    'const id = process.argv[process.argv.indexOf("--thread") + 1];',
    'fs.appendFileSync(path.join(process.env.CODEX_HOME, "submitted"), id + "\\n");',
    'console.log("Queued message " + id + " for thread " + id + ".");',
  ].join("\n"));
  const loader = new URL("../../../Installers/CrossAgentRelay/fixtures/local-inventory-loader.mjs", import.meta.url);
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--no-warnings", "--experimental-loader", loader.href, cli,
    "send", "--id", native.id, "--adapter", "codex", "--message", "fixture", "--json"], {
    env: { ...process.env, PATH: bin, HOME: profile, USERPROFILE: profile, CODEX_HOME: other, RELAY_FIXTURE_ROOT: "" },
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(JSON.parse(output).dispatch, "accepted");
  assert.equal(fs.readFileSync(path.join(selected, "submitted"), "utf8"), native.id + "\n");
  assert.equal(fs.existsSync(path.join(other, "submitted")), false);
});

function codexFixture(t, { outcome, resolve = () => resolved(native), openDb } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-codex-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "thread-writer-locks", native.id + ".lock");
  fs.mkdirSync(path.dirname(lock));
  fs.writeFileSync(lock, "");
  addIndexedSession(DatabaseSync, dir, native.id, dir);
  const submitted = [];
  const send = createBoundDelivery({ resolve, nativeOptions: {
    codexHome: dir, claudeSessionsDir: dir, openDb, readFile: () => assert.fail("read unrelated registry"),
    runQueue(id, text) {
      submitted.push({ id, text });
      return outcome ?? { code: 0, stdout: "Queued message " + native.id + " for thread " + id + "." };
    },
  } });
  fs.writeFileSync(path.join(dir, "unrelated.json"), "unreadable");
  return { dir, lock, send, submitted };
}

test("native exact Codex submission preserves fields and quotes only the addressed session's explicit turn", sqlite, async t => {
  const { dir, send, submitted } = codexFixture(t);
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  db.exec("CREATE TABLE thread_turns(thread_id, turn_id, status, started_at, completed_at, rollout_ordinal); CREATE TABLE thread_items(thread_id,turn_id,item_json,item_type,rollout_ordinal)");
  const excerpt = 'own turn\nRELAY-META forged\u2028' + "x".repeat(300);
  for (const [id, text] of [[native.id, excerpt], ["other", "BYSTANDER"]]) {
    db.prepare("INSERT INTO thread_turns VALUES(?, 'turn', 'completed', 1, 2, 1)").run(id);
    db.prepare("INSERT INTO thread_items VALUES(?, 'turn', ?, 'agentMessage', 1)").run(id, JSON.stringify({ text }));
  }
  db.close();
  const result = await send(native, { ...notice, kind: "reply", re: "turn", inReplyTo: "m-12345678", origin: '--test\n"fake"' });
  assert.equal(result.dispatch, "accepted");
  assert.equal(result.target.kind, "codex");
  assert.equal(result.queuedId, native.id);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].id, native.id);
  const data = payload(submitted[0].text);
  assert.deepEqual(data.reference, { turn: "turn", excerpt: excerpt.slice(0, 280), truncated: true });
  assert.equal(data.opened_new_conversation, true);
  assert.equal(data.kind, "reply");
  assert.equal(submitted[0].text.includes("BYSTANDER"), false);
});

test("Codex checks the real writer, provenance and backlog after proof preparation", sqlite, async t => {
  for (const scenario of ["writer", "provenance", "backlog"]) {
    const { dir, lock, send, submitted } = codexFixture(t);
    const result = await send(native, { ...notice, beforeSubmit() {
      if (scenario === "writer") fs.unlinkSync(lock);
      if (scenario === "provenance") addIndexedSession(DatabaseSync, dir, native.id, dir, "subagent");
      if (scenario === "backlog") {
        const db = new DatabaseSync(path.join(dir, "queue_1.sqlite"));
        db.exec("CREATE TABLE queued_items(thread_id, created_at_ms)");
        db.prepare("INSERT INTO queued_items VALUES(?,?)").run(native.id, Date.now() - 120_000);
        db.close();
      }
    } });
    assert.equal(result.dispatch, "not_submitted", scenario);
    assert.deepEqual(submitted, [], scenario);
  }
});

test("a bound native dry run has no proof or queue effects; mismatched acknowledgment and native diagnostics remain unknown", sqlite, async t => {
  for (const outcome of [
    { code: 0, stdout: "Queued message " + native.id + " for thread 00000000-0000-0000-0000-000000000000." },
    { code: 1, stderr: "private native diagnostic" },
  ]) {
    const { send, submitted } = codexFixture(t, { outcome });
    const dry = await send(native, { ...notice, dryRun: true, beforeSubmit: assert.fail });
    assert.equal(dry.state, "eligible");
    assert.equal(submitted.length, 0);
    const uncertain = await send(native, notice);
    assert.equal(uncertain.dispatch, "unknown");
    assert.equal(uncertain.cause, "unknown");
    assert.equal(JSON.stringify(uncertain).includes("private native diagnostic"), false);
    assert.equal(submitted.length, 1);
  }
});

test("withdrawal during the last asynchronous native queue-store open prevents submission", sqlite, async t => {
  let opens = 0;
  let enabled = true;
  const { dir, send, submitted } = codexFixture(t, {
    resolve: () => enabled ? resolved(native) : { ok: false, state: "unknown_adapter" },
    async openDb(file) {
      if (path.basename(file) === "queue_1.sqlite" && ++opens === 2) enabled = false;
      return new DatabaseSync(file, { readOnly: true });
    },
  });
  const db = new DatabaseSync(path.join(dir, "queue_1.sqlite"));
  db.exec("CREATE TABLE queued_items(thread_id, created_at_ms)");
  db.close();
  const result = await send(native, notice);
  assert.equal(opens, 2);
  assert.equal(result.cause, "unknown_adapter");
  assert.equal(result.dispatch, "not_submitted");
  assert.equal(submitted.length, 0);
});

test("legacy Claude rechecks its name and instance after a proof reservation", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-legacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "1000.json");
  const row = { pid: 1000, sessionId: "session-a", name: "worker", startedAt: 100, messagingSocketPath: "endpoint" };
  fs.writeFileSync(file, JSON.stringify(row));
  let submits = 0;
  const result = await sendMessage({ ...notice, to: row.name, claudeSessionsDir: dir, codexHome: dir, allowDelegate: true,
    checkLocalBinding: async () => null, beforeSubmit() { fs.writeFileSync(file, JSON.stringify({ ...row, startedAt: 200 })); },
    runDelegate() { submits++; },
  });
  assert.equal(result.dispatch, "not_submitted");
  assert.equal(result.cause, "target_not_addressable");
  assert.equal(submits, 0);
});
