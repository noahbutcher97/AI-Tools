import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readTrialMetadata, summarizeTrial } from "./fixtures/ReadTurnMetadata.mjs";

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
