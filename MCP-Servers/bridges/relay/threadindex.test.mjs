import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverTargets, stripExtendedPrefix } from "./client.mjs";

// Codex keeps its own thread index in state_5.sqlite: `threads` carries
// `rollout_path`, `cwd` and `thread_source` per thread id. Reading it replaces
// a full walk of ~1700 rollout files plus a first-line read of each match, and
// removes relay's dependence on the rollout FILENAME convention.
//
// Two things in that table would be silent bugs if taken at face value:
//   - 1648 of 1723 cwd values carry the \\?\ extended-length prefix, which does
//     not compare equal to the plain path a caller passes.
//   - thread_source is null on 74 rows, so it cannot be trusted as present.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-idx-"));
}

const STATE_DDL = `CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
  approval_mode TEXT NOT NULL, thread_source TEXT)`;

const TURNS_DDL = `CREATE TABLE IF NOT EXISTS thread_turns (
  thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
  status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER,
  duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT,
  rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER,
  PRIMARY KEY (thread_id, turn_id))`;

function codexHome() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "thread-writer-locks"));
  fs.mkdirSync(path.join(dir, "sessions", "2026", "08", "23"), { recursive: true });
  return dir;
}

function lock(home, id = THREAD) {
  fs.writeFileSync(path.join(home, "thread-writer-locks", `${id}.lock`), "");
}

function turns(home, id = THREAD) {
  const db = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  db.exec(TURNS_DDL);
  db.prepare("insert into thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at) values (?,?,?,?,?,?)")
    .run(id, "t1", 1, "completed", NOW_S - 180, NOW_S - 120);
  db.close();
}

// A rollout written somewhere the filename convention would NOT find it, so a
// test that passes can only have used the indexed path.
function rolloutAtOddPath(home, id, meta = {}) {
  const file = path.join(home, "sessions", "2026", "08", "23", "unconventional-name.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id, session_id: id, cwd: "D:\\Work\\Alpha", thread_source: "user", ...meta } })}\n`,
  );
  return file;
}

function index(home, rows) {
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(STATE_DDL);
  const ins = db.prepare(
    "insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, thread_source) values (?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const r of rows) {
    ins.run(r.id, r.rolloutPath ?? "", NOW_S, NOW_S, r.source ?? "cli", "openai", r.cwd, "", "", "", r.threadSource ?? null);
  }
  db.close();
}

function discover(home, extra = {}) {
  return discoverTargets({ codexHome: home, claudeSessionsDir: tmpdir(), now: NOW, scope: "all", ...extra });
}

// ── The extended-length prefix ──

test("the windows extended-length prefix is stripped from an indexed cwd", () => {
  assert.equal(stripExtendedPrefix("\\\\?\\D:\\Work\\Alpha"), "D:\\Work\\Alpha");
});

test("a path without the prefix is left alone", () => {
  assert.equal(stripExtendedPrefix("D:\\Work\\Alpha"), "D:\\Work\\Alpha");
});

test("an indexed cwd carrying the prefix still matches a plainly-written workspace", needsStore, async () => {
  // 1648 of 1723 live rows carry this prefix. Comparing it raw would make scope
  // filtering silently miss almost every real session.
  const home = codexHome();
  lock(home);
  turns(home);
  index(home, [{ id: THREAD, cwd: "\\\\?\\D:\\Work\\Alpha", threadSource: "user", rolloutPath: rolloutAtOddPath(home, THREAD) }]);

  const { targets } = await discover(home, { scope: "cwd", cwd: "D:\\Work\\Alpha" });

  assert.deepEqual(targets.map((t) => t.id), [THREAD]);
});

// ── Using the index ──

test("the rollout is found through the index, not by guessing at filenames", needsStore, async () => {
  // The rollout here is deliberately named so the filename convention cannot
  // locate it. Resolving cwd at all proves the indexed path was used.
  const home = codexHome();
  lock(home);
  turns(home);
  index(home, [{ id: THREAD, cwd: "\\\\?\\D:\\Work\\Alpha", threadSource: null, rolloutPath: rolloutAtOddPath(home, THREAD) }]);

  const { targets } = await discover(home);

  assert.equal(targets[0].cwd, "D:\\Work\\Alpha");
});

test("thread_source from the index filters subagents without opening a rollout", needsStore, async () => {
  const home = codexHome();
  lock(home);
  lock(home, "01a02f38-aea9-7fe1-9aa7-e8f246fb1dfa");
  turns(home);
  turns(home, "01a02f38-aea9-7fe1-9aa7-e8f246fb1dfa");
  index(home, [
    { id: THREAD, cwd: "\\\\?\\D:\\Work\\Alpha", threadSource: "user", rolloutPath: "" },
    { id: "01a02f38-aea9-7fe1-9aa7-e8f246fb1dfa", cwd: "\\\\?\\D:\\Work\\Alpha", threadSource: "subagent", rolloutPath: "" },
  ]);

  const { targets } = await discover(home);

  assert.deepEqual(targets.map((t) => t.id), [THREAD]);
});

test("a null thread source leaves the ID unaddressable even when rollout content supplies a kind", needsStore, async t => {
  // 74 indexed rows have no thread_source. Treating null as "user" would offer
  // subagent internals as targets; treating it as "subagent" would hide real
  // sessions.
  const home = codexHome();
  lock(home);
  turns(home);
  index(home, [
    { id: THREAD, cwd: "\\\\?\\D:\\Work\\Alpha", threadSource: null, rolloutPath: rolloutAtOddPath(home, THREAD, { thread_source: "subagent" }) },
  ]);

  const opened = [];
  const open = fs.openSync;
  t.mock.method(fs, "openSync", function(file, ...args) {
    if (typeof file === "string" && file.endsWith(".jsonl")) opened.push(file);
    return open.call(this, file, ...args);
  });
  const { targets } = await discover(home);

  assert.deepEqual(targets.map(t => [t.id, t.addressable]), [[THREAD, false]]);
  assert.deepEqual(opened, []);
});

test("a locked thread absent from the index is reported, not silently dropped", needsStore, async () => {
  const home = codexHome();
  lock(home);
  turns(home);
  index(home, []);

  const { targets, warnings } = await discover(home);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].addressable, false);
  assert.equal(warnings.length, 1);
});

test("a missing index leaves the workspace unknown even when a rollout exists", needsStore, async () => {
  // Older Codex installs, or a machine where state_5 has not been created yet.
  const home = codexHome();
  lock(home);
  turns(home);
  fs.writeFileSync(
    path.join(home, "sessions", "2026", "08", "23", `rollout-2026-08-23T11-08-20-${THREAD}.jsonl`),
    `${JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: THREAD, session_id: THREAD, cwd: "D:\\Work\\Alpha", thread_source: "user" } })}\n`,
  );

  const { targets } = await discover(home);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].cwd, null);
  assert.equal(targets[0].addressable, false);
});
