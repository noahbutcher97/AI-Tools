import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { digest } from "./delivery-protocol.mjs";
import { captureCursor, prove } from "./proof.mjs";
import { localPing, localStatus } from "./local-ping.mjs";
import { runProvider } from "./provider-process.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
function profileDir(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-proof-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return profile;
}

test("Codex proof consumes only an exact post-cursor user message in the same thread", async t => {
  const profile = profileDir(t);
  const dir = path.join(profile, ".codex");
  fs.mkdirSync(dir);
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  t.after(() => { if (db.isOpen) db.close(); });
  db.exec("CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal INTEGER,item_type,item_json)");
  const insert = (thread, n, type, text) => db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?)")
    .run(thread, "turn", String(n), n, type, JSON.stringify({ type, clientId: "different-from-queue-id", content: [{ type: "text", text }] }));
  const text = "fixture message id and fresh nonce";
  insert(id, 1, "userMessage", text);
  const cursor = await captureCursor({ kind: "codex", id }, { profile });
  insert(other, 2, "userMessage", text);
  insert(id, 3, "agentMessage", text);
  insert(id, 4, "userMessage", text.replace("fresh nonce", "old nonce"));
  insert(id, 5, "userMessage", text.replace("message id", "other id"));
  assert.equal(await prove(cursor, digest(text), { profile }), "pending");
  insert(id, 6, "userMessage", text);
  assert.equal(await prove(cursor, digest(text), { profile }), "delivered");
  db.prepare("DELETE FROM thread_items WHERE rollout_ordinal=1").run();
  assert.equal(await prove(cursor, digest(text), { profile }), "proof_unavailable");
  db.close();
});

test("a concurrent history rewrite cannot combine an old cursor and a new consumed row", async t => {
  const profile = profileDir(t), dir = path.join(profile, ".codex");
  fs.mkdirSync(dir);
  const writer = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal INTEGER,item_type,item_json)");
    const insert = writer.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?)");
    insert.run(id, other, "anchor", 1, "agentMessage", "{}");
    const cursor = await captureCursor({ kind: "codex", id }, { profile });
    const prepare = DatabaseSync.prototype.prepare;
    let rewrites = 0, bindings = 0;
    t.mock.method(DatabaseSync.prototype, "prepare", function(sql, ...args) {
      if (sql.includes("item_type='userMessage'") && !rewrites) {
        writer.exec("BEGIN; DELETE FROM thread_items");
        insert.run(id, other, "replacement", 2, "userMessage", JSON.stringify({
          type: "userMessage", content: [{ type: "text", text: "notice" }] }));
        writer.exec("COMMIT");
        rewrites++;
      }
      return prepare.call(this, sql, ...args);
    });
    const options = { profile, onCodexTurn: () => bindings++ };
    assert.equal(await prove(cursor, digest("notice"), options), "pending");
    assert.equal(rewrites, 1);
    assert.equal(await prove(cursor, digest("notice"), options), "proof_unavailable");
    assert.equal(bindings, 0);
  } finally { writer.close(); }
});

test("Claude proof requires accepted peer metadata, original session and rendered bytes", async t => {
  const profile = profileDir(t);
  const dir = path.join(profile, ".claude", "projects", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + ".jsonl");
  fs.writeFileSync(file, "{}\n");
  const target = { kind: "claude", id, cwd: "fixture" };
  const cursor = await captureCursor(target, { profile });
  const text = "exact body";
  const accepted = { type: "user", isMeta: true, isSidechain: false, sessionId: id,
    message: { role: "user", content: "Peer: " + text }, origin: { kind: "peer", verifiedLocal: true, body: text } };
  const append = row => fs.appendFileSync(file, JSON.stringify(row) + "\n");
  for (const change of [{ type: "assistant" }, { isSidechain: true }, { sessionId: other },
    { origin: { ...accepted.origin, verifiedLocal: false } }, { message: { role: "user", content: "different" } }]) {
    append({ ...accepted, ...change });
  }
  assert.equal(await prove(cursor, digest(text), { profile }), "pending");
  append(accepted);
  assert.equal(await prove(cursor, digest(text), { profile }), "delivered");
  fs.writeFileSync(file, "[]\n");
  assert.equal(await prove(cursor, digest(text), { profile }), "proof_unavailable");
});

test("local status authenticates its cursor and never calls a provider or accepts an edited token", async t => {
  const profile = profileDir(t);
  let calls = 0, verifies = 0;
  const opts = { profile, waitMs: 0, send: async options => {
    calls++;
    assert.equal(options.exactId, true);
    await options.beforeSubmit({ id, kind: "codex" }, "rendered");
    return { ok: true };
  }, capture: async () => ({ kind: "codex", id, instance: "fixture" }),
  verify: async (cursor, expected) => { verifies++; assert.equal(expected, digest("rendered")); return "pending"; } };
  const result = await localPing(id, opts);
  assert.equal(result.state, "pending");
  assert.equal((await localStatus(result.handle, opts)).state, "pending");
  assert.equal((await localStatus(result.handle + "a", opts)).state, "proof_unavailable");
  assert.equal(calls, 1);
  assert.equal(verifies, 2);
});

test("provider adapter preserves bytes, bounds output and cancels a stalled child", async () => {
  const out = await runProvider(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdin: "same\nbytes" });
  assert.deepEqual(out, { stdout: "same\nbytes", stderr: "", code: 0 });
  await assert.rejects(runProvider(process.execPath, ["-e", "process.stdout.write('x'.repeat(512))"], { maxBytes: 100 }), /unknown/);
  await assert.rejects(runProvider(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 200 }), /unknown/);
});
