import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { matches, UUID } from "../../../MCP-Servers/bridges/relay/delivery-protocol.mjs";

function readOnly(file, query) {
  assert.ok(path.isAbsolute(file) && path.relative(file, fs.realpathSync.native(file)) === "");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=500");
    return query(db);
  } finally { db.close(); }
}

// The study admits two turns and two user items per turn. One lookahead
// prevents a truncated input projection from supporting an origin decision.
export function readTrialTurns(thread, profile) {
  assert.ok(matches(UUID, thread));
  return readOnly(path.join(profile, ".codex", "thread_history_1.sqlite"), db => {
    db.exec("BEGIN"); // Rows and their input IDs must come from one SQLite snapshot.
    const rows = db.prepare(`SELECT turn_id, rollout_ordinal, status, started_at, completed_at,
      root_turn_id, first_user_item_id FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal LIMIT 3`).all(thread);
    assert.ok(rows.length <= 2, "Unexpected additional turn in disposable thread");
    const inputs = db.prepare(`SELECT item_id FROM thread_items
      WHERE thread_id=? AND turn_id=? AND item_type='userMessage' ORDER BY rollout_ordinal LIMIT 3`);
    return rows.map(row => {
      const items = inputs.all(thread, row.turn_id);
      return { ...row, inputs: items.slice(0, 2).map(item => item.item_id), inputsComplete: items.length <= 2 };
    });
  });
}

// The cold observer receives the disposable thread and condition, with no
// ground-truth turn labels, queue confirmation, payload, or live connection.
export function readTrialMetadata(thread, condition, file, profile = os.homedir()) {
  assert.ok(matches(UUID, thread) && matches(UUID, condition));
  const dir = path.join(profile, ".codex");
  const turns = readTrialTurns(thread, profile);
  const queued = readOnly(path.join(dir, "queue_1.sqlite"), db =>
    db.prepare("SELECT COUNT(*) AS n FROM queued_items WHERE thread_id=?").get(thread).n);
  const watch = readOnly(file, db => db.prepare(`SELECT state, cursor, handle IS NOT NULL AS hasHandle,
    batch IS NOT NULL AS hasBatch FROM schedule_watches WHERE condition=?`).get(condition));
  return { turns, queued, watch: { ...watch } };
}

export function sampleTurnStatus(thread) {
  assert.ok(matches(UUID, thread));
  return readOnly(path.join(os.homedir(), ".codex", "thread_history_1.sqlite"), db =>
    db.prepare("SELECT turn_id, status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal LIMIT 3").all(thread));
}

export function confirmReadback(live, cold) {
  if (!isDeepStrictEqual(live, cold)) throw Error("Metadata changed across observer restart");
}

// Only the experiment coordinator knows which turn it started and what the
// queue acknowledged. Publish comparisons, never raw identifiers or times.
export function summarizeTrial(sample, seed, wake, queueId) {
  assert.ok([seed, wake, queueId].every(value => matches(UUID, value)) && seed !== wake);
  if (sample.turns.length !== 2 || sample.turns[0].turn_id !== seed || sample.turns[1].turn_id !== wake) {
    throw Error("Observed turns did not match the trial order");
  }
  assert.equal(sample.watch.state, "waiting");
  assert.equal(sample.watch.hasHandle, 0);
  assert.equal(sample.watch.hasBatch, 0);
  const observations = sample.turns.map(t => {
    assert.equal(t.inputs.length, 1);
    assert.ok(typeof t.inputs[0] === "string" && t.inputs[0].length > 0, "Missing trial input identifier");
    return {
      status: t.status, started: t.started_at !== null, ended: t.completed_at !== null,
      root: t.root_turn_id === null ? "absent" : t.root_turn_id === t.turn_id ? "self" : "other",
      firstUserMatchesInput: t.first_user_item_id === t.inputs[0],
      queueMatchesTurn: queueId === t.turn_id, queueMatchesRoot: queueId === t.root_turn_id,
      queueMatchesFirstUser: queueId === t.first_user_item_id, queueMatchesInput: queueId === t.inputs[0]
    };
  });
  return { ordinary: observations[0], watcher: observations[1], queueRowsRemaining: sample.queued,
    completedOrdinalsIncrease: sample.turns[0].rollout_ordinal < sample.turns[1].rollout_ordinal,
    watchState: sample.watch.state, proofHandleRetained: Boolean(sample.watch.hasHandle) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 5);
  process.stdout.write(JSON.stringify(readTrialMetadata(...process.argv.slice(2))));
}
