import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverTargets, formatTargets, normalizeCwd, parseArgs } from "./client.mjs";

// node:sqlite arrived in Node 22.5 and the bridge treats it as an optional
// capability, so the tests that build a real thread store skip rather than fail
// on an older runtime. The rollout-only degradation test does not need it and
// always runs — which is the point of having that path.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const needsStore = { skip: DatabaseSync ? false : "node:sqlite unavailable on this runtime" };

// A fixed clock. Every idleFor assertion below is written so that confusing
// seconds for milliseconds — the two stores disagree on units, see the codex
// tests — changes the number by 1000x and fails the test.
const NOW = 1787507400000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
}

// A registry directory holding one <pid>.json per session, exactly as
// ~/.claude/sessions does.
function claudeRegistry(sessions) {
  const dir = tmpdir();
  for (const s of sessions) fs.writeFileSync(path.join(dir, `${s.pid}.json`), JSON.stringify(s));
  return dir;
}

function claudeSession(overrides = {}) {
  return {
    pid: 1000,
    sessionId: "sess-1000",
    cwd: "D:\\Work\\Alpha",
    startedAt: NOW - 3_600_000,
    version: "2.1.241",
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-abc",
    name: "alpha-one",
    status: "idle",
    updatedAt: NOW - 90_000,
    statusUpdatedAt: NOW - 90_000,
    ...overrides,
  };
}

// A codex home with an empty lock directory: no live threads, so discovery
// must not need the sqlite store at all.
function emptyCodexHome() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "thread-writer-locks"));
  return dir;
}

async function discoverClaude(sessions, options = {}) {
  return discoverTargets({
    claudeSessionsDir: claudeRegistry(sessions),
    codexHome: emptyCodexHome(),
    now: NOW,
    scope: "all",
    ...options,
  });
}

// ── normalizeCwd ──
//
// Windows hands the same directory back in several spellings: the drive letter
// case varies by which process reported it, separators mix, and a trailing
// separator is optional. Scope filtering is an equality compare, so an
// un-normalized compare silently drops targets that should have matched.

test("normalizeCwd makes windows drive letter case irrelevant", () => {
  assert.equal(normalizeCwd("D:\\Work\\Alpha"), normalizeCwd("d:\\Work\\Alpha"));
});

test("normalizeCwd treats forward and back slashes as the same separator", () => {
  assert.equal(normalizeCwd("D:/Work/Alpha"), normalizeCwd("D:\\Work\\Alpha"));
});

test("normalizeCwd ignores a trailing separator", () => {
  assert.equal(normalizeCwd("D:\\Work\\Alpha\\"), normalizeCwd("D:\\Work\\Alpha"));
});

test("normalizeCwd keeps genuinely different directories different", () => {
  assert.notEqual(normalizeCwd("D:\\Work\\Alpha"), normalizeCwd("D:\\Work\\Beta"));
});

// ── Claude discovery ──

test("discovery reports a live claude session from the registry", async () => {
  const { targets } = await discoverClaude([claudeSession()]);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, "sess-1000");
  assert.equal(targets[0].name, "alpha-one");
  assert.equal(targets[0].kind, "claude");
  assert.equal(targets[0].status, "idle");
  assert.equal(targets[0].cwd, "D:\\Work\\Alpha");
});

test("claude idleFor is milliseconds since the status last changed", async () => {
  const session = claudeSession({ statusUpdatedAt: NOW - 90_000 });

  const { targets } = await discoverClaude([session]);

  assert.equal(targets[0].idleFor, 90_000);
});

test("a busy claude session reports no idle time rather than a misleading one", async () => {
  const session = claudeSession({ status: "busy", statusUpdatedAt: NOW - 5_000 });

  const { targets } = await discoverClaude([session]);

  assert.equal(targets[0].status, "busy");
  assert.equal(targets[0].idleFor, null);
});

test("a claude session with a messaging socket is addressable", async () => {
  const { targets } = await discoverClaude([claudeSession()]);

  assert.equal(targets[0].addressable, true);
});

test("a claude session without a messaging socket is reported unaddressable, not omitted", async () => {
  // A registry entry with no socket path is a real session that cannot be
  // reached. Dropping it would make it invisible; listing it as sendable would
  // produce a confusing delivery error later.
  const { targets } = await discoverClaude([claudeSession({ messagingSocketPath: "" })]);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].addressable, false);
  assert.match(targets[0].reason, /socket/i);
});

test("claude turn count is unknown, never a zero that would read as unaddressable", async () => {
  // Codex marks turns:0 as not-yet-addressable (spec 3.5). Claude turn counts
  // are not in the registry, so reporting 0 here would borrow that meaning and
  // be wrong.
  const { targets } = await discoverClaude([claudeSession()]);

  assert.equal(targets[0].turns, null);
});

test("discovery never opens the session key files that sit beside the registry", async () => {
  // Spec safety discipline 4. Asserting only that the secret is absent from the
  // output would leave an implementation that reads every .key file and
  // discards it passing unchanged, so this pins the read itself.
  const dir = claudeRegistry([claudeSession()]);
  fs.writeFileSync(path.join(dir, "1000.abc123.key"), "SECRET-PIPE-AUTH");
  const opened = [];

  const { targets } = await discoverTargets({
    claudeSessionsDir: dir,
    codexHome: emptyCodexHome(),
    now: NOW,
    scope: "all",
    readFile: (file, encoding) => {
      opened.push(file);
      return fs.readFileSync(file, encoding);
    },
  });

  assert.equal(targets.length, 1);
  assert.equal(opened.some((f) => f.endsWith(".key")), false, "a .key file was opened");
  assert.equal(opened.some((f) => f.endsWith(".json")), true, "the registry read did not go through the injected reader");
});

test("session key contents never reach discovery output", async () => {
  const dir = claudeRegistry([claudeSession()]);
  fs.writeFileSync(path.join(dir, "1000.abc123.key"), "SECRET-PIPE-AUTH");

  const { targets } = await discoverTargets({
    claudeSessionsDir: dir,
    codexHome: emptyCodexHome(),
    now: NOW,
    scope: "all",
  });

  assert.equal(JSON.stringify(targets).includes("SECRET-PIPE-AUTH"), false);
});

test("one unreadable registry file does not hide the sessions beside it", async () => {
  const dir = claudeRegistry([claudeSession()]);
  fs.writeFileSync(path.join(dir, "9999.json"), "{ this is not json");

  const { targets, warnings } = await discoverTargets({
    claudeSessionsDir: dir,
    codexHome: emptyCodexHome(),
    now: NOW,
    scope: "all",
  });

  assert.equal(targets.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /9999\.json/);
});

test("an absent claude registry degrades to a warning instead of throwing", async () => {
  const { targets, warnings } = await discoverTargets({
    claudeSessionsDir: path.join(tmpdir(), "does-not-exist"),
    codexHome: emptyCodexHome(),
    now: NOW,
    scope: "all",
  });

  assert.deepEqual(targets, []);
  assert.equal(warnings.length, 1);
});

test("a one-shot delegate session is never offered as a target", async () => {
  // Measured: `claude -p` registers with kind "interactive" and a live
  // messaging socket, indistinguishable from a real session by either — but
  // entrypoint is "sdk-cli" rather than "cli". Without this filter the relay
  // offers its own delegate spawns as targets, and a message to one is lost
  // when it exits mid-turn, seconds later.
  const { targets } = await discoverClaude([
    claudeSession(),
    claudeSession({ pid: 2000, sessionId: "sess-2000", name: "relay-32", entrypoint: "sdk-cli" }),
  ]);

  assert.deepEqual(targets.map((t) => t.name), ["alpha-one"]);
});

test("an empty codex lock directory yields no codex targets and no warning", async () => {
  // Discovery must not need the 400MB thread store when nothing is live.
  const { targets, warnings } = await discoverClaude([claudeSession()]);

  assert.deepEqual(targets.map((t) => t.kind), ["claude"]);
  assert.deepEqual(warnings, []);
});

// ── Codex discovery ──
//
// A Codex target is assembled from three places, because no single one carries
// enough. thread-writer-locks says which threads are live; thread_turns says
// how many turns they have taken and what the last one did; only the rollout's
// session_meta record carries cwd and thread_source, which are the two fields
// scope filtering and subagent filtering need.

const TURNS_DDL = `CREATE TABLE IF NOT EXISTS thread_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_json TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    first_user_item_id TEXT,
    final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER,
    PRIMARY KEY (thread_id, turn_id)
)`;

// Codex stores turn timestamps in unix SECONDS while the Claude registry uses
// milliseconds. NOW_S is the fixed clock expressed the way Codex writes it.
const NOW_S = Math.floor(NOW / 1000);

function codexHome() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "thread-writer-locks"));
  fs.mkdirSync(path.join(dir, "sessions", "2026", "08", "23"), { recursive: true });
  return dir;
}

function addLock(home, id) {
  fs.writeFileSync(path.join(home, "thread-writer-locks", `${id}.lock`), "");
}

// The rollout's first record. Only the handful of fields discovery reads are
// written here; the real record also carries the full base instructions, which
// is why the reader must not slurp the whole line-one payload blindly.
function addRollout(home, id, meta = {}) {
  const record = {
    timestamp: "2026-08-23T15:08:20.957Z",
    ordinal: 0,
    type: "session_meta",
    payload: {
      session_id: id,
      id,
      cwd: "D:\\Work\\Alpha",
      originator: "codex-tui",
      thread_source: "user",
      ...meta,
    },
  };
  const file = path.join(home, "sessions", "2026", "08", "23", `rollout-2026-08-23T11-08-20-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(record)}\n{"type":"response_item"}\n`);
}

function addTurns(home, rows) {
  const db = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  db.exec(TURNS_DDL);
  const insert = db.prepare(
    "insert into thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at) values (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    insert.run(r.threadId, r.turnId, r.ordinal, r.status, r.startedAt ?? null, r.completedAt ?? null);
  }
  db.close();
}

const USER_THREAD = "01a02f2a-5dca-7a23-a7f2-e45b985059f3";
const SUBAGENT_THREAD = "01a02f38-aea9-7fe1-9aa7-e8f246fb1dfa";

// A live user thread that has taken one completed turn, two minutes ago.
function liveUserThread(home, id = USER_THREAD, meta = {}) {
  addLock(home, id);
  addRollout(home, id, meta);
  addTurns(home, [
    { threadId: id, turnId: "turn-1", ordinal: 1, status: "completed", startedAt: NOW_S - 180, completedAt: NOW_S - 120 },
  ]);
}

async function discoverCodex(home, options = {}) {
  return discoverTargets({
    // An existing but empty registry, so these assertions see only the
    // warnings the codex side produced.
    claudeSessionsDir: tmpdir(),
    codexHome: home,
    now: NOW,
    scope: "all",
    ...options,
  });
}

test("discovery reports a live codex user thread", needsStore, async () => {
  const home = codexHome();
  liveUserThread(home);

  const { targets } = await discoverCodex(home);

  const codex = targets.filter((t) => t.kind === "codex");
  assert.equal(codex.length, 1);
  assert.equal(codex[0].id, USER_THREAD);
  assert.equal(codex[0].cwd, "D:\\Work\\Alpha");
  assert.equal(codex[0].turns, 1);
  assert.equal(codex[0].addressable, true);
});

test("codex idleFor converts the store's seconds into milliseconds", needsStore, async () => {
  // thread_turns.completed_at is unix seconds; the Claude registry is
  // milliseconds. Getting this backwards is off by 1000x, which this fixed
  // clock catches.
  const home = codexHome();
  liveUserThread(home);

  const { targets } = await discoverCodex(home);

  assert.equal(targets.find((t) => t.kind === "codex").idleFor, 120_000);
});

test("a codex thread whose latest turn is still running reports busy", needsStore, async () => {
  const home = codexHome();
  addLock(home, USER_THREAD);
  addRollout(home, USER_THREAD);
  addTurns(home, [
    { threadId: USER_THREAD, turnId: "t1", ordinal: 1, status: "completed", startedAt: NOW_S - 600, completedAt: NOW_S - 500 },
    { threadId: USER_THREAD, turnId: "t2", ordinal: 2, status: "inProgress", startedAt: NOW_S - 30 },
  ]);

  const { targets } = await discoverCodex(home);
  const codex = targets.find((t) => t.kind === "codex");

  assert.equal(codex.status, "busy");
  assert.equal(codex.idleFor, null);
});

test("an interrupted codex turn leaves the thread idle, not failed", needsStore, async () => {
  // interrupted is the second most common status in the live store. It means
  // the human stopped the turn, which leaves an ordinary idle thread.
  const home = codexHome();
  addLock(home, USER_THREAD);
  addRollout(home, USER_THREAD);
  addTurns(home, [
    { threadId: USER_THREAD, turnId: "t1", ordinal: 1, status: "interrupted", startedAt: NOW_S - 300, completedAt: NOW_S - 240 },
  ]);

  const { targets } = await discoverCodex(home);
  const codex = targets.find((t) => t.kind === "codex");

  assert.equal(codex.status, "idle");
  assert.equal(codex.addressable, true);
});

test("a codex subagent thread is not offered as a target", needsStore, async () => {
  // Over three days this machine held 132 threads of which 3 were root chats.
  // Without this filter the list is mostly other agents' internals.
  const home = codexHome();
  liveUserThread(home);
  addLock(home, SUBAGENT_THREAD);
  addRollout(home, SUBAGENT_THREAD, {
    thread_source: "subagent",
    session_id: USER_THREAD,
    parent_thread_id: USER_THREAD,
    agent_nickname: "Dirac the 2nd",
  });
  addTurns(home, [
    { threadId: SUBAGENT_THREAD, turnId: "t1", ordinal: 1, status: "completed", startedAt: NOW_S - 60, completedAt: NOW_S - 30 },
  ]);

  const { targets } = await discoverCodex(home);

  assert.deepEqual(targets.filter((t) => t.kind === "codex").map((t) => t.id), [USER_THREAD]);
});

test("a codex thread is keyed by its own id, not the root id its session_id carries", needsStore, async () => {
  // Measured: thread 01a02f2a-5dca carried session_id 01a020bf-943f, the id of
  // the thread it forked from. Keying on session_id collapses distinct threads
  // onto their parent.
  const home = codexHome();
  liveUserThread(home, USER_THREAD, { session_id: "01a020bf-943f-7ee0-a01f-f97875fd23d4" });

  const { targets } = await discoverCodex(home);

  assert.equal(targets.find((t) => t.kind === "codex").id, USER_THREAD);
});

test("a lock file that is not a thread id is ignored", needsStore, async () => {
  // .coordination.lock shares the directory and comes and goes.
  const home = codexHome();
  liveUserThread(home);
  fs.writeFileSync(path.join(home, "thread-writer-locks", ".coordination.lock"), "");

  const { targets, warnings } = await discoverCodex(home);

  assert.deepEqual(targets.filter((t) => t.kind === "codex").map((t) => t.id), [USER_THREAD]);
  assert.deepEqual(warnings, []);
});

test("a codex thread with zero turns is listed as not yet addressable, not as sendable", needsStore, async () => {
  // Spec 3.5: `codex queue` rejects a zero-turn thread with "no rollout found
  // for thread id". Listing it as sendable turns a knowable state into a
  // confusing delivery error.
  const home = codexHome();
  addLock(home, USER_THREAD);
  addRollout(home, USER_THREAD);
  addTurns(home, []);

  const { targets } = await discoverCodex(home);
  const codex = targets.find((t) => t.kind === "codex");

  assert.equal(codex.turns, 0);
  assert.equal(codex.addressable, false);
  assert.match(codex.reason, /turn/i);
});

test("a live lock with no rollout is reported unaddressable rather than dropped", needsStore, async () => {
  const home = codexHome();
  addLock(home, USER_THREAD);
  addTurns(home, []);

  const { targets, warnings } = await discoverCodex(home);
  const codex = targets.find((t) => t.kind === "codex");

  assert.equal(codex.id, USER_THREAD);
  assert.equal(codex.addressable, false);
  assert.equal(codex.cwd, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rollout/i);
});

test("without the thread store, codex targets degrade to rollout-only instead of going dark", async () => {
  // The store is the only part that needs node:sqlite. cwd, thread_source and
  // the fact that a thread has run at all all come from the rollout, so losing
  // sqlite costs turn counts and timing, not the whole Codex half.
  const home = codexHome();
  addLock(home, USER_THREAD);
  addRollout(home, USER_THREAD);
  // The store file is present; what is missing is the runtime's ability to open
  // it, which is the Node 18 case the engines field allows.
  fs.writeFileSync(path.join(home, "thread_history_1.sqlite"), "");

  const { targets, warnings } = await discoverCodex(home, {
    openDb: () => {
      throw new Error("node:sqlite unavailable");
    },
  });
  const codex = targets.find((t) => t.kind === "codex");

  assert.equal(codex.id, USER_THREAD);
  assert.equal(codex.cwd, "D:\\Work\\Alpha");
  assert.equal(codex.turns, null);
  assert.equal(codex.addressable, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /node:sqlite unavailable/);
});

test("a claude registry and a codex store are read in the same pass", needsStore, async () => {
  const home = codexHome();
  liveUserThread(home);

  const { targets } = await discoverTargets({
    claudeSessionsDir: claudeRegistry([claudeSession()]),
    codexHome: home,
    now: NOW,
    scope: "all",
  });

  assert.deepEqual(targets.map((t) => t.kind).sort(), ["claude", "codex"]);
});

// ── Scope ──
//
// Spec 4.2: the default scope is the caller's cwd, and --scope all widens it
// deliberately. Workspace is a default filter, never a boundary, so nothing is
// unreachable — it just is not listed by default.

async function discoverBothWorkspaces(options = {}) {
  const home = codexHome();
  liveUserThread(home, USER_THREAD, { cwd: "D:\\Work\\Beta" });
  return discoverTargets({
    claudeSessionsDir: claudeRegistry([
      claudeSession({ pid: 1000, sessionId: "sess-1000", name: "alpha-one", cwd: "D:\\Work\\Alpha" }),
      claudeSession({ pid: 2000, sessionId: "sess-2000", name: "beta-one", cwd: "D:\\Work\\Beta" }),
    ]),
    codexHome: home,
    now: NOW,
    ...options,
  });
}

test("scope defaults to the caller's own workspace", needsStore, async () => {
  // From a subdirectory, because that is where commands actually get typed. An
  // exact-cwd match would report that the caller's own session does not exist.
  const { targets } = await discoverBothWorkspaces({ cwd: "D:\\Work\\Alpha\\src\\bridges" });

  assert.deepEqual(targets.map((t) => t.name), ["alpha-one"]);
});

test("a session rooted below the caller's workspace is in scope", needsStore, async () => {
  // The other direction: standing at the repo root while a session works in a
  // subfolder of it. A workspace is a tree, not a point.
  const { targets } = await discoverTargets({
    claudeSessionsDir: claudeRegistry([claudeSession({ cwd: "D:\\Work\\Alpha\\packages\\api" })]),
    codexHome: emptyCodexHome(),
    now: NOW,
    cwd: "D:\\Work\\Alpha",
  });

  assert.deepEqual(targets.map((t) => t.name), ["alpha-one"]);
});

test("a sibling workspace sharing a name prefix is not in scope", needsStore, async () => {
  // Prefix matching has to respect path segments: D:\Work\Alpha and
  // D:\Work\AlphaBeta are unrelated directories.
  const { targets } = await discoverTargets({
    claudeSessionsDir: claudeRegistry([claudeSession({ cwd: "D:\\Work\\Alpha" })]),
    codexHome: emptyCodexHome(),
    now: NOW,
    cwd: "D:\\Work\\AlphaBeta",
  });

  assert.deepEqual(targets, []);
});

test("scope all reaches sessions in other workspaces", needsStore, async () => {
  const { targets } = await discoverBothWorkspaces({ cwd: "D:\\Work\\Alpha", scope: "all" });

  assert.deepEqual(targets.map((t) => t.name).sort(), [USER_THREAD, "alpha-one", "beta-one"]);
});

test("scope matches a workspace across both agent kinds", needsStore, async () => {
  const { targets } = await discoverBothWorkspaces({ cwd: "D:\\Work\\Beta" });

  assert.deepEqual(targets.map((t) => t.kind).sort(), ["claude", "codex"]);
});

test("scope matching survives a differently spelled but identical path", needsStore, async () => {
  // The registry records whatever spelling the session was launched with, so a
  // caller in d:/Work/Alpha/ must still match a session in D:\Work\Alpha.
  const { targets } = await discoverBothWorkspaces({ cwd: "d:/Work/Alpha/" });

  assert.deepEqual(targets.map((t) => t.name), ["alpha-one"]);
});

test("a target whose workspace is unknown is withheld from a scoped list, not guessed into it", needsStore, async () => {
  // A locked codex thread with no rollout has no cwd. Assuming it belongs to
  // the caller's workspace would be a guess; --scope all still finds it.
  const home = codexHome();
  addLock(home, USER_THREAD);
  addTurns(home, []);
  const common = { claudeSessionsDir: tmpdir(), codexHome: home, now: NOW, cwd: "D:\\Work\\Alpha" };

  const scoped = await discoverTargets(common);
  const all = await discoverTargets({ ...common, scope: "all" });

  assert.deepEqual(scoped.targets, []);
  assert.deepEqual(all.targets.map((t) => t.id), [USER_THREAD]);
});

// ── list rendering ──

const CLAUDE_TARGET = {
  id: "sess-1000",
  name: "alpha-one",
  kind: "claude",
  status: "idle",
  idleFor: 90_000,
  cwd: "D:\\Work\\Alpha",
  turns: null,
  addressable: true,
  reason: null,
};

test("list renders a target's name, kind, status and idle time", () => {
  const out = formatTargets({ targets: [CLAUDE_TARGET], warnings: [] });

  assert.match(out, /alpha-one/);
  assert.match(out, /claude/);
  assert.match(out, /idle/);
  assert.match(out, /1m 30s/);
});

test("list keeps the largest unit of a long idle time", () => {
  // A session idle since yesterday must not read as though it just went idle.
  // Peers idle for 23h and for more than a day were live on this machine while
  // Unit 1 was being built, and idleFor is the field an orchestrator reads to
  // decide whether a peer is stuck.
  const out = formatTargets({ targets: [{ ...CLAUDE_TARGET, idleFor: 90_000_000 }], warnings: [] });

  assert.match(out, /1d 1h/);
});

test("list renders a sub-minute idle time without inventing larger units", () => {
  const out = formatTargets({ targets: [{ ...CLAUDE_TARGET, idleFor: 12_000 }], warnings: [] });

  assert.match(out, /idle 12s/);
});

test("list marks an unaddressable target and gives the reason", () => {
  // The whole point of listing a not-yet-addressable target is that the caller
  // learns why instead of discovering it as a delivery error.
  const out = formatTargets({
    targets: [{ ...CLAUDE_TARGET, kind: "codex", name: "01a02f2a", turns: 0, addressable: false, reason: "thread has taken 0 turns; not yet addressable" }],
    warnings: [],
  });

  assert.match(out, /not addressable/i);
  assert.match(out, /0 turns/);
});

test("list surfaces warnings rather than presenting a degraded read as complete", () => {
  const out = formatTargets({ targets: [CLAUDE_TARGET], warnings: ["codex turn counts unavailable (node:sqlite unavailable)"] });

  assert.match(out, /node:sqlite unavailable/);
});

test("list says the scope was empty instead of printing nothing", () => {
  const out = formatTargets({ targets: [], warnings: [] });

  assert.match(out, /no .*(target|session)/i);
});

// ── CLI argument parsing ──
//
// The CLI face is the hand-debugging path and the escape hatch when the MCP
// server is not loaded in a session (spec 4.1), so its parsing is the part
// worth testing; printing is not.

test("list is the command when none is given", () => {
  assert.equal(parseArgs([]).command, "list");
});

test("scope defaults to the caller's workspace at the command line too", () => {
  assert.equal(parseArgs(["list"]).scope, "cwd");
});

test("--scope all widens the listing", () => {
  assert.equal(parseArgs(["list", "--scope", "all"]).scope, "all");
});

test("--json asks for the machine-readable form", () => {
  assert.equal(parseArgs(["list", "--json"]).json, true);
});

test("--cwd overrides the workspace being scoped to", () => {
  assert.equal(parseArgs(["list", "--cwd", "D:\\Work\\Beta"]).cwd, "D:\\Work\\Beta");
});

test("an unknown flag is refused rather than silently ignored", () => {
  // Silently ignoring --scop=all would return the caller's own workspace and
  // look like an empty machine.
  assert.throws(() => parseArgs(["list", "--scop", "all"]), /unknown/i);
});

test("an unknown command is refused", () => {
  assert.throws(() => parseArgs(["sned", "alpha-one"]), /unknown/i);
});

test("a scope other than cwd or all is refused", () => {
  assert.throws(() => parseArgs(["list", "--scope", "everything"]), /scope/i);
});

test("a flag that needs a value is refused when the value is missing", () => {
  assert.throws(() => parseArgs(["list", "--scope"]), /--scope/);
});

test("send takes the target as a positional argument", () => {
  const args = parseArgs(["send", "01a02f2a-5dca-7a23-a7f2-e45b985059f3", "--message", "hello"]);

  assert.equal(args.command, "send");
  assert.equal(args.to, "01a02f2a-5dca-7a23-a7f2-e45b985059f3");
  assert.equal(args.message, "hello");
});

test("send without a target is refused", () => {
  assert.throws(() => parseArgs(["send", "--message", "hello"]), /target/i);
});

test("send leaves the message unset when none is given, so the caller can pipe one", () => {
  // Shell quoting corrupts multi-line prose, which is why stdin exists as the
  // other way in.
  assert.equal(parseArgs(["send", "some-target"]).message, undefined);
});

test("--dry-run resolves the target without queueing anything", () => {
  assert.equal(parseArgs(["send", "some-target", "--dry-run"]).dryRun, true);
});

test("the delegate is off at the command line unless asked for", () => {
  // The delegate contains a model call. From a Claude session it is also
  // pointless, since SendMessage is right there. It exists on the CLI as the
  // hand-debugging path for the MCP face (spec 4.1).
  assert.equal(parseArgs(["send", "peer", "--message", "hi"]).viaDelegate, false);
});

test("--via-delegate opts in to the claude relay path", () => {
  assert.equal(parseArgs(["send", "peer", "--message", "hi", "--via-delegate"]).viaDelegate, true);
});

test("--from declares a claimed origin for the delegate to stamp", () => {
  assert.equal(parseArgs(["send", "peer", "--message", "hi", "--from", "ai-tools-dd"]).from, "ai-tools-dd");
});

test("list does not accept a positional target", () => {
  assert.throws(() => parseArgs(["list", "some-target"]), /unknown|list/i);
});
