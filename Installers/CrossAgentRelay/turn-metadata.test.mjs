import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readTrialMetadata, summarizeTrial } from "./fixtures/ReadTurnMetadata.mjs";
import { checkTurnReceipt, receiptStillMatches } from "./fixtures/CheckTurnReceipt.mjs";
import { localStatus, sendProvedNotice } from "../../MCP-Servers/bridges/relay/local-ping.mjs";

test("the observer needs only scoped metadata and preserves a positive queue-ID match", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "relay-turn-study-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".codex");
  fs.mkdirSync(dir);
  const thread = randomUUID(), condition = randomUUID(), ordinary = randomUUID(), wake = randomUUID();
  const ordinaryItem = randomUUID(), wakeItem = randomUUID(), other = randomUUID();
  const history = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  try {
    history.exec("CREATE TABLE thread_turns(thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,root_turn_id,first_user_item_id);" +
      "CREATE TABLE thread_items(thread_id,turn_id,item_id,item_type,rollout_ordinal)");
    const turn = history.prepare("INSERT INTO thread_turns VALUES(?,?,?,'completed',1,2,?,?)");
    const user = history.prepare("INSERT INTO thread_items VALUES(?,?,?,'userMessage',1)");
    turn.run(thread, ordinary, 1, ordinary, ordinaryItem);
    turn.run(thread, wake, 2, wake, wakeItem);
    turn.run(other, wake, 3, wake, wakeItem);
    user.run(thread, ordinary, ordinaryItem);
    user.run(thread, wake, wakeItem);
    user.run(other, wake, randomUUID());
  } finally { history.close(); }
  const queue = new DatabaseSync(path.join(dir, "queue_1.sqlite"));
  try {
    queue.exec("CREATE TABLE queued_items(thread_id)");
    queue.prepare("INSERT INTO queued_items VALUES(?)").run(other);
  } finally { queue.close(); }
  const file = path.join(root, "jobs.sqlite");
  const jobs = new DatabaseSync(file);
  try {
    jobs.exec("CREATE TABLE schedule_watches(condition,state,cursor,handle,batch)");
    const insert = jobs.prepare("INSERT INTO schedule_watches VALUES(?,?,0,NULL,NULL)");
    insert.run(other, "observing");
    insert.run(condition, "waiting");
  } finally { jobs.close(); }
  const sample = readTrialMetadata(thread, condition, file, root);
  const positive = summarizeTrial(sample, ordinary, wake, wakeItem);
  assert.equal(positive.ordinary.queueMatchesInput, false);
  assert.equal(positive.watcher.queueMatchesInput, true);
  assert.equal(positive.watcher.queueMatchesFirstUser, true);
  assert.equal(positive.queueRowsRemaining, 0);
  const negative = summarizeTrial(sample, ordinary, wake, randomUUID());
  assert.deepEqual(negative.ordinary, negative.watcher);
  for (const id of [thread, condition, ordinary, wake, ordinaryItem, wakeItem]) {
    assert.ok(!JSON.stringify(positive).includes(id));
  }
  assert.throws(() => summarizeTrial(sample, wake, ordinary, wakeItem));
  assert.throws(() => readTrialMetadata("invalid", condition, file, root));
});

test("failed comparisons keep private identifiers and timestamps out of process output", () => {
  const reader = new URL("./fixtures/ReadTurnMetadata.mjs", import.meta.url).href;
  const seed = randomUUID(), wake = randomUUID(), queue = randomUUID();
  const stamp = "2099-12-31T23:59:59Z";
  const sample = { turns: [{ turn_id: wake, started_at: stamp }, { turn_id: seed }] };
  for (const [call, reason] of [
    ["confirmReadback(sample, {})", "Metadata changed across observer restart"],
    ["summarizeTrial(sample, ...labels)", "Observed turns did not match the trial order"],
  ]) {
    const program = `import { confirmReadback, summarizeTrial } from ${JSON.stringify(reader)};
      const [sample, labels] = JSON.parse(process.argv[1]);
      ${call}`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", program,
      JSON.stringify([sample, [seed, wake, queue]])], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(reason));
    for (const value of [seed, wake, queue, stamp]) assert.ok(!(run.stdout + run.stderr).includes(value));
  }
});

test("a retained receipt identifies only its unique consumed input and cannot authorize other turns", async t => {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "relay-turn-proof-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const dir = path.join(profile, ".codex");
  fs.mkdirSync(dir);
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  t.after(() => { if (db.isOpen) db.close(); });
  const thread = randomUUID(), other = randomUUID(), ordinary = randomUUID(), mixed = randomUUID();
  const notice = "one exact fixture envelope";
  db.exec("CREATE TABLE thread_items(thread_id,turn_id,item_id,rollout_ordinal INTEGER,item_type,item_json)");
  const insert = db.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?)");
  function user(target, turn, ordinal, text) {
    insert.run(target, turn, randomUUID(), ordinal, "userMessage", JSON.stringify({ type: "userMessage", content: [{ type: "text", text }] }));
  }
  user(thread, ordinary, 1, notice);
  const { handle } = await sendProvedNotice(thread, notice, { profile, deferProof: true, send: async options => {
    await options.beforeSubmit({ id: thread, kind: "codex" }, notice);
    return { ok: true };
  } });
  user(other, mixed, 2, notice);
  user(thread, mixed, 3, "ordinary input");
  assert.equal((await checkTurnReceipt(handle, profile)).status.state, "pending");
  user(thread, mixed, 4, notice);
  const { binding, status } = await checkTurnReceipt(handle, profile);
  assert.equal(status.state, "delivered");
  assert.deepEqual(Object.keys(binding).sort(), ["instance", "thread", "turn"]);
  assert.equal(binding.thread, thread);
  assert.equal(binding.turn, mixed);
  assert.ok(!JSON.stringify(await localStatus(handle, { profile })).includes(mixed));
  assert.ok(await receiptStillMatches({ handle, binding }, profile));
  for (const change of [{ thread: other }, { turn: ordinary }, { instance: "changed" }]) {
    assert.equal(await receiptStillMatches({ handle, binding: { ...binding, ...change } }, profile), false);
  }
  assert.equal(await receiptStillMatches({ handle: handle + "x", binding }, profile), false);
  user(thread, ordinary, 5, notice);
  assert.equal((await localStatus(handle, { profile })).state, "delivered");
  assert.equal(await receiptStillMatches({ handle, binding }, profile), false);
  db.exec("DELETE FROM thread_items WHERE rollout_ordinal=5");
  for (let n = 5; n <= 260; n++) user(thread, ordinary, n, "ordinary input");
  assert.equal(await receiptStillMatches({ handle, binding }, profile), false);
  db.exec("DELETE FROM thread_items WHERE rollout_ordinal >= 5 OR rollout_ordinal = 1");
  assert.equal(await receiptStillMatches({ handle, binding }, profile), false);
  db.close();
});
