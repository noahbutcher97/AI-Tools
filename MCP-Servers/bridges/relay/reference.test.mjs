import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRelayEnvelope, parseArgs, resolveReference, sendMessage } from "./client.mjs";


// Unit 5 — threading (spec 4.6).
//
// `--re <turnId>` attaches a message to the claim it is about, so the receiver
// gets a referent instead of a context-free interruption.
//
// The load-bearing rule: **a reference must carry an excerpt, not just an id.**
// A turn id stays valid after the turn it names has been compacted out of the
// receiving session's context — and compaction is not hypothetical, the live
// store shows 115 contextCompaction markers in a single thread. A bare id can
// therefore address something the peer no longer remembers, so relay quotes the
// referenced turn from the peer's own record and sends the quote along with it.

const NOW = 1787507400000;
const NOW_S = Math.floor(NOW / 1000);
const NONCE = "test-nonce-2222";
const THREAD = "01a02f2a-5dca-7a23-a7f2-e45b985059f3";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const needsStore = { skip: DatabaseSync ? false : "node:sqlite unavailable on this runtime" };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-ref-"));
}

const LONG_CLAIM =
  "I have confirmed the motion-correction path is fully deterministic under all sixteen startup permutations, " +
  "including the charged variants, and there is no remaining nondeterminism in the queue drain. " +
  "This was verified against the full editor build rather than the unit harness.";

function codexHome() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "thread-writer-locks"));
  fs.mkdirSync(path.join(dir, "sessions", "2026", "08", "23"), { recursive: true });
  fs.writeFileSync(path.join(dir, "thread-writer-locks", `${THREAD}.lock`), "");
  fs.writeFileSync(
    path.join(dir, "sessions", "2026", "08", "23", `rollout-2026-08-23T11-08-20-${THREAD}.jsonl`),
    `${JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: THREAD, session_id: THREAD, cwd: "D:\\Work\\Alpha", thread_source: "user" } })}\n`,
  );
  const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, PRIMARY KEY (thread_id, turn_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, turn_id, item_id))`);
  db.prepare("insert into thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at) values (?,?,?,?,?,?)")
    .run(THREAD, "turn-a", 1, "completed", NOW_S - 600, NOW_S - 540);
  db.prepare("insert into thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at) values (?,?,?,?,?,?)")
    .run(THREAD, "turn-b", 10, "completed", NOW_S - 300, NOW_S - 240);
  const ins = db.prepare("insert into thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type) values (?,?,?,?,?,?,?)");
  ins.run(THREAD, "turn-a", "u1", 2, NOW - 600_000, JSON.stringify({ type: "userMessage", id: "u1", content: [{ type: "text", text: "is the motion path deterministic?" }] }), "userMessage");
  ins.run(THREAD, "turn-a", "a1", 3, NOW - 560_000, JSON.stringify({ type: "agentMessage", id: "a1", text: LONG_CLAIM }), "agentMessage");
  ins.run(THREAD, "turn-b", "a2", 11, NOW - 250_000, JSON.stringify({ type: "agentMessage", id: "a2", text: "Opened the file for edit." }), "agentMessage");
  db.close();
  return dir;
}

function opts(home, extra = {}) {
  return { codexHome: home, claudeSessionsDir: tmpdir(), now: NOW, ...extra };
}

// ── Resolution ──

test("a reference resolves to the referenced turn's own words", needsStore, async () => {
  const home = codexHome();

  const ref = await resolveReference({ to: THREAD, re: "turn-a", ...opts(home) });

  assert.equal(ref.ok, true);
  assert.equal(ref.turnId, "turn-a");
  assert.match(ref.excerpt, /motion-correction path is fully deterministic/);
});

test("the excerpt quotes the agent's claim, not the human's question", needsStore, async () => {
  // "attaches a message to the claim it is about" — a reply is almost always
  // about something the agent asserted.
  const home = codexHome();

  const ref = await resolveReference({ to: THREAD, re: "turn-a", ...opts(home) });

  assert.doesNotMatch(ref.excerpt, /is the motion path deterministic/);
});

test("the excerpt is capped rather than pasting a whole turn back", needsStore, async () => {
  const home = codexHome();

  const ref = await resolveReference({ to: THREAD, re: "turn-a", ...opts(home), excerptLimit: 60 });

  assert.equal(ref.excerpt.length <= 60, true);
  assert.equal(ref.truncated, true);
});

test("a turn id that is not in the target's thread is refused, not sent dangling", needsStore, async () => {
  // A dangling reference is worse than none: it asserts a shared referent that
  // does not exist, and the recipient cannot tell which.
  const home = codexHome();

  const ref = await resolveReference({ to: THREAD, re: "turn-nonexistent", ...opts(home) });

  assert.equal(ref.ok, false);
  assert.match(ref.detail, /not found|no turn/i);
});

test("a turn with no conversational text says so rather than quoting nothing", needsStore, async () => {
  const home = codexHome();
  const db = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  db.prepare("insert into thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at) values (?,?,?,?,?,?)")
    .run(THREAD, "turn-silent", 20, "completed", NOW_S - 100, NOW_S - 90);
  db.close();

  const ref = await resolveReference({ to: THREAD, re: "turn-silent", ...opts(home) });

  assert.equal(ref.ok, false);
  assert.match(ref.detail, /no conversational text|nothing to quote/i);
});

test("referencing a claude target is refused with the reason, not a bad guess", needsStore, async () => {
  // The Unit 4 read layer covers Codex only, so relay cannot quote a Claude
  // turn. Sending the id alone would violate the excerpt rule.
  const home = codexHome();
  const claudeDir = tmpdir();
  fs.writeFileSync(
    path.join(claudeDir, "1000.json"),
    JSON.stringify({ pid: 1000, sessionId: "s1", name: "alpha-one", cwd: "D:\\Work\\Alpha", status: "idle", statusUpdatedAt: NOW - 1000, messagingSocketPath: "\\\\.\\pipe\\x", entrypoint: "cli" }),
  );

  const ref = await resolveReference({ to: "alpha-one", re: "some-uuid", ...opts(home, { claudeSessionsDir: claudeDir }) });

  assert.equal(ref.ok, false);
  assert.match(ref.detail, /claude/i);
});

// ── Rendering ──

test("the reference and its excerpt ride outside the body markers", () => {
  // The excerpt is relay-authored quotation of the recipient's own words. Inside
  // the body region it would be indistinguishable from the sender's new text.
  const { text } = buildRelayEnvelope({
    message: "I do not think that holds for the charged variants.",
    reference: { turnId: "turn-a", excerpt: LONG_CLAIM.slice(0, 80), truncated: true },
    nonce: NONCE,
  });
  const outside = text.slice(0, text.indexOf(`RELAY-${NONCE}-BODY-BEGIN`));

  assert.match(outside, /turn-a/);
  assert.match(outside, /motion-correction path/);
});

test("the rendered reference explains why the quote is there", () => {
  // The recipient may have compacted that turn away; without the explanation a
  // quote of their own words reads as redundant rather than as a referent.
  const { text } = buildRelayEnvelope({
    message: "disagree",
    reference: { turnId: "turn-a", excerpt: "some claim", truncated: false },
    nonce: NONCE,
  });

  assert.match(text, /compact|no longer|your own/i);
});

test("a truncated excerpt is marked as truncated", () => {
  const { text } = buildRelayEnvelope({
    message: "disagree",
    reference: { turnId: "turn-a", excerpt: "some claim", truncated: true },
    nonce: NONCE,
  });

  assert.match(text, /truncat|…|\.\.\./i);
});

test("no reference means no reference block", () => {
  const { text } = buildRelayEnvelope({ message: "hello", nonce: NONCE });

  assert.doesNotMatch(text, /in reply to/i);
});

// ── CLI ──

test("--re takes a turn id", () => {
  const args = parseArgs(["send", "some-target", "--re", "turn-a", "--message", "hi"]);

  assert.equal(args.re, "turn-a");
});

test("--re without a value is refused", () => {
  assert.throws(() => parseArgs(["send", "t", "--re"]), /--re/);
});

// ── Through send ──

test("a send with a reference carries the excerpt to the recipient", needsStore, async () => {
  const home = codexHome();
  const sent = [];

  const result = await sendMessage({
    to: THREAD,
    message: "I do not think that holds for the charged variants.",
    re: "turn-a",
    ...opts(home),
    spoolPath: path.join(tmpdir(), "spool.log"),
    runQueue: (threadId, text) => {
      sent.push(text);
      return { code: 0, stdout: `Queued message 01a03006-8830-7222-8c64-aa539cbe65cc for thread ${threadId}.\n`, stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.match(sent[0], /turn-a/);
  assert.match(sent[0], /motion-correction path/);
});

test("a send whose reference cannot be resolved fails instead of dropping the reference", needsStore, async () => {
  // Silently sending without the referent would turn a threaded reply into the
  // context-free interruption the feature exists to prevent.
  const home = codexHome();
  const sent = [];

  const result = await sendMessage({
    to: THREAD,
    message: "disagree",
    re: "turn-nonexistent",
    ...opts(home),
    spoolPath: path.join(tmpdir(), "spool.log"),
    runQueue: (threadId, text) => {
      sent.push(text);
      return { code: 0, stdout: "Queued message x for thread y.\n", stderr: "" };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(sent, [], "a dangling reference was sent anyway");
});
