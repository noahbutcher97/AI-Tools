import { addIndexedSession } from "./fixtures/session-index.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SEND_CAUSES, sendMessage } from "./client.mjs";


// Lock presence over-reports liveness: proven 2026-08-24, four locks survived
// with every Codex process stopped, and discovery still called one addressable.
// Queueing into such a thread returns exit 0 and the message waits undelivered,
// possibly forever.
//
// Process enumeration was considered as a pre-flight guard and REJECTED: it
// costs a PowerShell spawn per check, and a filter that silently matches nothing
// — which is exactly what a mangled `tasklist /FI` did during this work — makes
// relay refuse every send while Codex is running normally. A false negative
// there is worse than the false positive it fixes.
//
// `queued_items` gives a cheap and sound signal instead. A message still sitting
// undelivered past the wake threshold is direct evidence the thread is not
// consuming: it PROVES non-consumption rather than inferring liveness.

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const needsStore = { skip: DatabaseSync ? false : "node:sqlite unavailable on this runtime" };

const NOW = 1787507400000;
const NOW_S = Math.floor(NOW / 1000);
const THREAD = "01a02f2a-5dca-7a23-a7f2-e45b985059f3";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-backlog-"));
}

function codexHome() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "thread-writer-locks"));
  fs.mkdirSync(path.join(dir, "sessions", "2026", "08", "23"), { recursive: true });
  fs.writeFileSync(path.join(dir, "thread-writer-locks", `${THREAD}.lock`), "");
  addIndexedSession(DatabaseSync, dir, THREAD, "D:\\Work\\Alpha");
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, PRIMARY KEY (thread_id, turn_id))`);
  db.prepare("insert into thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at) values (?,?,?,?,?,?)")
    .run(THREAD, "t1", 1, "completed", NOW_S - 180, NOW_S - 120);
  db.close();
  return dir;
}

function queueDb(home, rows) {
  const db = new DatabaseSync(path.join(home, "queue_1.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS queued_items (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL, queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)`);
  const ins = db.prepare("insert into queued_items (id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms) values (?,?,?,?,?,?)");
  for (const [i, r] of rows.entries()) ins.run(`q${i}`, r.threadId, "{}", i, r.createdAtMs, r.createdAtMs);
  db.close();
}

function send(home, extra = {}) {
  const calls = [];
  return sendMessage({
    to: THREAD,
    message: "hello",
    codexHome: home,
    claudeSessionsDir: tmpdir(),
    now: NOW,
    spoolPath: path.join(tmpdir(), "spool.log"),
    runQueue: (threadId, text) => {
      calls.push({ threadId, text });
      return { code: 0, stdout: `Queued message 01a03006-8830-7222-8c64-aa539cbe65cc for thread ${threadId}.\n`, stderr: "" };
    },
    ...extra,
  }).then((result) => ({ result, calls }));
}

test("a thread sitting on an old undelivered message is refused", needsStore, async () => {
  // The message is 10 minutes old and still queued. Wake latency was measured
  // at ~9s, so this thread is demonstrably not consuming.
  const home = codexHome();
  queueDb(home, [{ threadId: THREAD, createdAtMs: NOW - 600_000 }]);

  const { result, calls } = await send(home);

  assert.equal(result.ok, false);
  assert.equal(result.cause, SEND_CAUSES.NOT_CONSUMING);
  assert.deepEqual(calls, [], "a message was queued onto a thread that is not draining");
});

test("the refusal says how long the backlog has been waiting", needsStore, async () => {
  const home = codexHome();
  queueDb(home, [{ threadId: THREAD, createdAtMs: NOW - 600_000 }]);

  const { result } = await send(home);

  assert.match(result.detail, /undelivered|not consum|pending/i);
  assert.match(result.detail, /10m|600|minute/i);
});

test("a message queued moments ago does not trigger a refusal", needsStore, async () => {
  // Below the wake threshold it is ordinary in-flight traffic, not evidence of
  // a dead thread. Refusing here would break normal back-to-back sends.
  const home = codexHome();
  queueDb(home, [{ threadId: THREAD, createdAtMs: NOW - 3_000 }]);

  const { result, calls } = await send(home);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("a backlog belonging to a different thread is irrelevant", needsStore, async () => {
  const home = codexHome();
  queueDb(home, [{ threadId: "01a09999-0000-7000-a000-000000000000", createdAtMs: NOW - 600_000 }]);

  const { result } = await send(home);

  assert.equal(result.ok, true);
});

test("an empty queue store lets the send proceed", needsStore, async () => {
  const home = codexHome();
  queueDb(home, []);

  const { result } = await send(home);

  assert.equal(result.ok, true);
});

test("an absent queue store fails open rather than blocking every send", needsStore, async () => {
  // The check exists to catch a specific proven failure. If it cannot run, the
  // correct behaviour is to proceed as before — a guard that fails closed would
  // refuse all traffic on an older Codex install, which is worse than the
  // over-reporting it was added to fix.
  const home = codexHome();

  const { result, calls } = await send(home);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("an unreadable queue store also fails open", needsStore, async () => {
  const home = codexHome();
  fs.writeFileSync(path.join(home, "queue_1.sqlite"), "this is not a database");

  const { result } = await send(home);

  assert.equal(result.ok, true);
});

test("the threshold is configurable so the wake measurement can be revised", needsStore, async () => {
  const home = codexHome();
  queueDb(home, [{ threadId: THREAD, createdAtMs: NOW - 45_000 }]);

  const strict = await send(home, { backlogThresholdMs: 30_000 });
  const lenient = await send(home, { backlogThresholdMs: 120_000 });

  assert.equal(strict.result.ok, false);
  assert.equal(lenient.result.ok, true);
});

test("a refused send still spools the message", needsStore, async () => {
  const home = codexHome();
  const spoolPath = path.join(tmpdir(), "spool.log");
  queueDb(home, [{ threadId: THREAD, createdAtMs: NOW - 600_000 }]);

  await send(home, { spoolPath });

  assert.match(fs.readFileSync(spoolPath, "utf8"), new RegExp(SEND_CAUSES.NOT_CONSUMING));
});
