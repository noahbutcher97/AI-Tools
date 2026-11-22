import { recoveryFixture } from "./fixtures/private-spool.mjs";
import { addIndexedSession } from "./fixtures/session-index.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SEND_CAUSES, defaultSpoolPath, parseMetaFromMessage, sendMessage } from "./client.mjs";


const NOW = 1787507400000;
const NOW_S = Math.floor(NOW / 1000);
const THREAD = "01a02f2a-5dca-7a23-a7f2-e45b985059f3";
const DEAD_THREAD = "01a02f8e-6c28-7d33-964d-126cbb18f538";
const MESSAGE = "please re-run the bridge tests when you get a moment";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const needsStore = { skip: DatabaseSync ? false : "node:sqlite unavailable on this runtime" };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-send-"));
}

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

function addLock(home, id) {
  fs.writeFileSync(path.join(home, "thread-writer-locks", `${id}.lock`), "");
}

function addIndexedThread(home, id, meta = {}) {
  if (DatabaseSync) addIndexedSession(DatabaseSync, home, id, meta.cwd ?? "D:\\Work\\Alpha", meta.thread_source ?? "user");
}

function addTurns(home, rows) {
  const db = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  db.exec(TURNS_DDL);
  const insert = db.prepare(
    "insert into thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at) values (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) insert.run(r.threadId, r.turnId, r.ordinal, r.status, r.startedAt, r.completedAt);
  db.close();
}

function liveThread(home, id = THREAD) {
  addLock(home, id);
  addIndexedThread(home, id);
  addTurns(home, [
    { threadId: id, turnId: "t1", ordinal: 1, status: "completed", startedAt: NOW_S - 180, completedAt: NOW_S - 120 },
  ]);
}

// The measured shape of a successful `codex queue` invocation.
function queued(messageId = "01a03006-8830-7222-8c64-aa539cbe65cc") {
  return { code: 0, stdout: `Queued message ${messageId} for thread ${THREAD}.\n`, stderr: "" };
}

function refuses(stderr) {
  return { code: 1, stdout: "", stderr };
}

function harness(home, overrides = {}) {
  const calls = [];
  const spoolPath = path.join(recoveryFixture(), "spool.log");
  return {
    calls,
    spoolPath,
    options: {
      codexHome: home,
      claudeSessionsDir: tmpdir(),
      now: NOW,
      spoolPath,
      runQueue: (threadId, text) => {
        calls.push({ threadId, text });
        return queued();
      },
      ...overrides,
    },
  };
}

function spoolText(spoolPath) {
  return fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, "utf8") : "";
}

// ── The happy path ──

test("a message to a live codex thread is queued", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].threadId, THREAD);
  // The queued text is stamped with a relay header, so the caller's message is
  // carried within it rather than being the whole of it. A queued message lands
  // as an ordinary userMessage and the recipient cannot otherwise tell it from
  // something a human typed.
  assert.equal(h.calls[0].text.includes(MESSAGE), true);
  assert.match(h.calls[0].text, /cross-agent relay/i);
});

test("a queued message reports the id codex assigned it", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.queuedId, "01a03006-8830-7222-8c64-aa539cbe65cc");
});

test("success says queued, never delivered", needsStore, async () => {
  // `codex queue` confirms an enqueue. Nothing in this unit can confirm a peer
  // received anything, and a queue into a thread that dies still reads as
  // success, so claiming delivery would be a false report.
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.match(result.detail, /queued/i);
  assert.doesNotMatch(result.detail, /delivered|sent to/i);
});

test("nothing is spooled when the message was queued", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(spoolText(h.spoolPath), "");
});

// ── Pre-flight liveness ──
//
// The measured hazard (spec 3.5): `codex queue` returns exit 0 and the same
// success string for a thread whose session has exited. Output parsing cannot
// see it. The lock file, re-read immediately before invoking, is the only guard.

test("a thread that exited after being listed is refused, not queued into", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);
  // The listing is taken, then the session exits before the send lands.
  const listed = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options, dryRun: true });
  assert.equal(listed.ok, true);
  fs.rmSync(path.join(home, "thread-writer-locks", `${THREAD}.lock`));

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.ok, false);
  assert.equal(result.cause, SEND_CAUSES.DISAPPEARED);
  assert.deepEqual(h.calls, [], "codex queue must not be invoked for a thread that is gone");
});

test("a thread that exits mid-flight is caught by the pre-flight re-check", needsStore, async () => {
  // The previous test is caught by discovery, so it does not exercise the
  // re-check at all. This one removes the lock AFTER discovery has already read
  // the lock directory — discovery reads locks before it opens the store, so an
  // openDb side effect lands in exactly that window. Without the re-check,
  // codex queue would be handed a dead thread and return exit 0 with a success
  // string (spec 3.5).
  const home = codexHome();
  liveThread(home);
  const lock = path.join(home, "thread-writer-locks", `${THREAD}.lock`);
  const h = harness(home, {
    openDb: async (file) => {
      fs.rmSync(lock, { force: true });
      return new DatabaseSync(file, { readOnly: true });
    },
  });

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.ok, false);
  assert.equal(result.cause, SEND_CAUSES.DISAPPEARED);
  assert.deepEqual(h.calls, [], "a dead thread must never reach codex queue");
});

test("a disappeared target tells the caller to re-list rather than blaming the address", needsStore, async () => {
  const home = codexHome();
  addIndexedThread(home, DEAD_THREAD);
  addTurns(home, [
    { threadId: DEAD_THREAD, turnId: "t1", ordinal: 1, status: "completed", startedAt: NOW_S - 900, completedAt: NOW_S - 800 },
  ]);
  const h = harness(home);

  const result = await sendMessage({ to: DEAD_THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.cause, SEND_CAUSES.DISAPPEARED);
  assert.match(result.detail, /re-?list|ended/i);
});

test("an address that never existed is distinguished from one that ended", needsStore, async () => {
  // Store presence is the discriminator. Without it both read as "not found"
  // and a caller cannot tell a typo from an ordinary race.
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  const result = await sendMessage({ to: "01a09999-0000-7000-a000-000000000000", message: MESSAGE, ...h.options });

  assert.equal(result.cause, SEND_CAUSES.NOT_FOUND);
  assert.deepEqual(h.calls, []);
});

test("a live thread with no turns is refused locally with its reason", needsStore, async () => {
  // `codex queue` would reject this with "no rollout found for thread id".
  // Catching it from discovery gives the caller the actual reason instead.
  const home = codexHome();
  addLock(home, THREAD);
  addIndexedThread(home, THREAD);
  addTurns(home, []);
  const h = harness(home);

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.cause, SEND_CAUSES.NOT_ADDRESSABLE);
  assert.match(result.detail, /turn/i);
  assert.deepEqual(h.calls, []);
});

// ── Kind ──

test("a claude target is refused with the reason, not attempted", needsStore, async () => {
  // SendMessage is an in-session tool, not a shell command. Every
  // shell-invocable path to a Claude target needs the Unit 3 delegate.
  const home = codexHome();
  const claudeDir = tmpdir();
  fs.writeFileSync(
    path.join(claudeDir, "1000.json"),
    JSON.stringify({ pid: 1000, sessionId: "sess-1000", name: "alpha-one", cwd: "D:\\Work\\Alpha", status: "idle", statusUpdatedAt: NOW - 1000, messagingSocketPath: "\\\\.\\pipe\\x" }),
  );
  const h = harness(home, { claudeSessionsDir: claudeDir });

  const result = await sendMessage({ to: "alpha-one", message: MESSAGE, ...h.options });

  assert.equal(result.cause, SEND_CAUSES.WRONG_KIND);
  assert.match(result.detail, /delegate|unit 3/i);
  assert.deepEqual(h.calls, []);
});

// ── Queue failures ──

test("a nonzero queue exit keeps provider output private", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home, {
    runQueue: () => refuses("Error: failed to queue session message: no rollout found for thread id (code -32603)"),
  });

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.cause, SEND_CAUSES.QUEUE_FAILED);
  assert.doesNotMatch(JSON.stringify(result), /-32603/);
});

test("a zero exit without a confirmation line is a failure, not a success", needsStore, async () => {
  // Defence in depth: exit 0 is necessary but not sufficient. If the
  // confirmation the CLI has always printed ever stops appearing, that is a
  // change worth failing on rather than assuming it worked.
  const home = codexHome();
  liveThread(home);
  const h = harness(home, { runQueue: () => ({ code: 0, stdout: "", stderr: "" }) });

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.ok, false);
  assert.equal(result.cause, SEND_CAUSES.QUEUE_FAILED);
  assert.match(result.detail, /confirm/i);
});

test("a queue invocation that cannot start at all is reported, not thrown", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home, {
    runQueue: () => {
      throw new Error("spawn codex ENOENT");
    },
  });

  const result = await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.equal(result.cause, SEND_CAUSES.QUEUE_FAILED);
  assert.doesNotMatch(JSON.stringify(result), /ENOENT/);
});

// ── Spool ──
//
// Spec section 6: human-readable, append-only, and never drained by an agent.
// A second delivery path reintroduces duplicate delivery, reordering, racing
// drains and ambiguous addressing — the reasons section 2 rejected one.

test("a failed send spools the message verbatim so nothing is lost", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home, { runQueue: () => refuses("boom") });

  await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });

  assert.match(spoolText(h.spoolPath), new RegExp(MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a spooled entry names the cause and the target", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home, { runQueue: () => refuses("boom") });

  await sendMessage({ to: THREAD, message: MESSAGE, ...h.options });
  const text = spoolText(h.spoolPath);

  assert.match(text, new RegExp(SEND_CAUSES.QUEUE_FAILED));
  assert.match(text, new RegExp(THREAD));
});

test("the spool appends rather than replacing the previous failure", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home, { runQueue: () => refuses("boom") });

  await sendMessage({ to: THREAD, message: "first message", ...h.options });
  await sendMessage({ to: THREAD, message: "second message", ...h.options });
  const text = spoolText(h.spoolPath);

  assert.match(text, /first message/);
  assert.match(text, /second message/);
});

test("a refusal that never reached codex is spooled too", needsStore, async () => {
  // Nothing was lost by the transport, but the caller's message still exists
  // and would otherwise vanish with the error.
  const home = codexHome();
  const h = harness(home);

  await sendMessage({ to: "01a09999-0000-7000-a000-000000000000", message: MESSAGE, ...h.options });

  assert.match(spoolText(h.spoolPath), new RegExp(SEND_CAUSES.NOT_FOUND));
});

test("the spool lives outside the repository by default", () => {
  // A spool under the bridge directory would show up in git status and
  // eventually in a commit, carrying message bodies with it.
  const spool = defaultSpoolPath();

  assert.equal(spool.startsWith(os.homedir()), true);
  assert.equal(spool.includes(`${path.sep}MCP-Servers${path.sep}`), false);
});

test("the module offers no way to read the spool back", async () => {
  // Spec section 2 and 6: the moment anything drains this file it becomes a
  // second delivery path. This pins the absence of that API deliberately.
  const module = await import("./client.mjs");
  const readers = Object.keys(module).filter((name) => /drain|retry|replay|readSpool|listSpool/i.test(name));

  assert.deepEqual(readers, []);
});

test("an unfamiliar host metadata key is recorded to the spool and does not block the send", needsStore, async () => {
  // A wiring test, not a unit test: newHostKeys is covered in isolation, and
  // that coverage stays green however the send path is wired. Two assertions,
  // because drift that blocks delivery and drift that goes unrecorded are
  // opposite failures and a test for one passes under the other.
  const home = codexHome();
  liveThread(home);
  const spoolFile = path.join(recoveryFixture(), "spool.log");
  const h = harness(home, { spoolPath: spoolFile });

  const result = await sendMessage({
    to: THREAD,
    message: MESSAGE,
    identity: {
      id: "codex-1",
      provider: "codex",
      channel: "request-metadata",
      host: { model: "m", codex_invented_this_yesterday: "surprise" },
    },
    ...h.options,
  });

  assert.equal(result.ok, true, "drift is a thing to look at, never a reason to refuse");
  assert.match(fs.readFileSync(spoolFile, "utf8"), /codex_invented_this_yesterday/);
});

// -- Conversation and message ids (typed-messages Task 6) --
//
// The plan duplicated the Codex fixture into conversation.test.mjs; this file
// already has one, and two fixtures for one shape drift apart.

const SESSION_A = { id: "session-a", provider: "claude", channel: "environment", host: {} };
const SESSION_B = { id: "session-b", provider: "claude", channel: "environment", host: {} };

test("every send carries a minted conversation and message id", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  const result = await sendMessage({
    to: THREAD, message: MESSAGE, identity: SESSION_A, ...h.options,
  });

  assert.match(result.conversation, /^c-[0-9a-f]{8}@session-a$/);
  assert.match(result.messageId, /^m-[0-9a-f]{8}$/);
  assert.equal(parseMetaFromMessage(h.calls[0].text).conversation, result.conversation);
});

test("a supplied conversation is carried, not replaced by a fresh mint", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  const result = await sendMessage({
    to: THREAD, message: MESSAGE, identity: SESSION_B,
    conversation: "c-1111aaaa@session-a", kind: "reply", inReplyTo: "m-abc12345", ...h.options,
  });

  const meta = parseMetaFromMessage(h.calls[0].text);

  assert.equal(result.conversation, "c-1111aaaa@session-a");
  assert.equal(meta.in_reply_to, "m-abc12345");
  assert.equal(meta.kind, "reply");
  assert.match(h.calls[0].text, /opened by session-a/);
});

test("a reply naming no conversation says relay opened a new one", needsStore, async () => {
  // Minting silently would start a new thread while the message claims to
  // continue an old one. A correlation pointing quietly at the wrong thread is
  // worse than one visibly absent.
  const home = codexHome();
  liveThread(home);
  const h = harness(home);

  await sendMessage({
    to: THREAD, message: MESSAGE, identity: SESSION_A,
    kind: "reply", ...h.options,
  });

  assert.match(h.calls[0].text, /relay opened a new conversation/i);
});
