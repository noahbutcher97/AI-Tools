import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONVERSATION_CAP, HOURLY_CAP, checkCaps, ledgerPath, recordSend } from "./ledger.mjs";

function tempLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-ledger-")), "ledger.log");
}

test("the ledger lives in the temp directory, not under the user profile", () => {
  // Load-bearing (spec 4.7), for a narrower reason than an earlier version of
  // this comment gave. Measured 2026-08-27: a Codex-spawned relay SERVER writes
  // under the home directory fine; it is the command line face, running in the
  // session shell, that is sandboxed. This file is written by BOTH faces, so it
  // has to live where the more restricted one can write. TEMP and TMP are among
  // the eighteen variables Codex passes, so both providers resolve one path,
  // and a counter split by provider would report a bound it was not enforcing.
  assert.equal(ledgerPath().startsWith(os.tmpdir()), true);
});

test("a conversation under the cap is allowed", () => {
  const p = tempLedger();
  for (let i = 0; i < CONVERSATION_CAP - 1; i++) recordSend(p, { now: 1000 + i, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: 2000, conversation: "c-1" }).allowed, true);
});

test("a conversation at the cap is refused, naming the conversation and the remedy", () => {
  // The first thing in this design that can refuse a legitimate send, so the
  // error has to be actionable rather than merely correct (spec 4.7).
  const p = tempLedger();
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(p, { now: 1000 + i, conversation: "c-1" });

  const verdict = checkCaps(p, { now: 2000, conversation: "c-1" });

  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /c-1/);
  assert.match(verdict.detail, /new conversation/i);
});

test("a different conversation is unaffected by another's cap", () => {
  const p = tempLedger();
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(p, { now: 1000 + i, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: 2000, conversation: "c-2" }).allowed, true);
});

test("a slow loop cannot reset itself by falling below the hourly window", () => {
  // Retention is 24h while the global window is 1h, so the conversation cap
  // counts every retained entry. Without this a loop at one message per 5
  // minutes never reaches any threshold (spec 4.7).
  const p = tempLedger();
  const hour = 3_600_000;
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(p, { now: i * hour, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: CONVERSATION_CAP * hour, conversation: "c-1" }).allowed, false);
});

test("the hourly cap catches a fresh conversation minted per message", () => {
  // Evading the conversation cap that way is no longer an accident, but it
  // costs exactly the same, so a coarse ceiling catches it.
  const p = tempLedger();
  for (let i = 0; i < HOURLY_CAP; i++) recordSend(p, { now: 1000 + i, conversation: `c-${i}` });

  const verdict = checkCaps(p, { now: 2000, conversation: "c-new" });

  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /hour/i);
});

test("entries older than the retention window stop counting toward the hourly cap", () => {
  const p = tempLedger();
  const day = 86_400_000;
  for (let i = 0; i < HOURLY_CAP; i++) recordSend(p, { now: 1000 + i, conversation: `c-${i}` });

  assert.equal(checkCaps(p, { now: 1000 + day + 1, conversation: "c-new" }).allowed, true);
});

test("an unreadable ledger fails open and says so", () => {
  // Refusing every send because a counter file broke would cause the outage the
  // counter exists to prevent. Defeatable by anyone who can make the file
  // unwritable, which is the adversary this design does not claim to stop.
  const verdict = checkCaps(path.join(os.tmpdir(), "relay-ledger-does-not-exist", "x.log"), {
    now: 1,
    conversation: "c-1",
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.inoperative, true);
});

test("a malformed line does not stop the ledger counting the rest", () => {
  // One corrupt line must not blind the counter to every other line.
  const p = tempLedger();
  recordSend(p, { now: 1000, conversation: "c-1" });
  fs.appendFileSync(p, "not json\n");
  recordSend(p, { now: 1001, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: 2000, conversation: "c-1" }).allowed, true);
});

test("a send with no conversation is still counted against the hourly cap", () => {
  // Otherwise omitting the conversation id would be a way past both caps, which
  // would make the primary cap advisory rather than enforced.
  const p = tempLedger();
  for (let i = 0; i < HOURLY_CAP; i++) recordSend(p, { now: 1000 + i, conversation: null });

  assert.equal(checkCaps(p, { now: 2000, conversation: null }).allowed, false);
});

test("RELAY_LEDGER relocates the ledger, so a test run cannot spend real quota", () => {
  // Found the hard way: without this the suite appended to the machine-wide
  // ledger, and after two hundred test sends every further test failed on the
  // hourly cap. Tests that consume the operator's real quota are a defect in
  // the tests AND in the code that gave them no way out.
  const before = process.env.RELAY_LEDGER;
  try {
    process.env.RELAY_LEDGER = path.join(os.tmpdir(), "relay-override-probe.log");
    assert.equal(ledgerPath(), path.join(os.tmpdir(), "relay-override-probe.log"));

    delete process.env.RELAY_LEDGER;
    assert.equal(ledgerPath().endsWith("cross-agent-relay-ledger.log"), true);
  } finally {
    if (before === undefined) delete process.env.RELAY_LEDGER;
    else process.env.RELAY_LEDGER = before;
  }
});

test("expired entries are compacted out rather than accumulating forever", () => {
  // recordSend only appends, so without compaction the file grows without bound
  // AND every cap check parses all of it - the check gets slower forever. The
  // spec claimed the file stays under five thousand lines at the ceiling, which
  // describes a file that prunes.
  const p = tempLedger();
  const day = 86_400_000;
  const now = 10 * day;
  for (let i = 0; i < 50; i++) recordSend(p, { now: 1000 + i, conversation: "old" });
  recordSend(p, { now, conversation: "current" });

  checkCaps(p, { now, conversation: "current" });

  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);

  assert.equal(lines.length, 1, "only entries inside the retention window survive");
  assert.equal(lines[0].includes("current"), true);
});

test("compaction keeps entries that are still inside the window", () => {
  // The mirror failure: a compactor that drops live entries would silently
  // reset the caps it exists to keep.
  const p = tempLedger();
  const now = 86_400_000;
  for (let i = 0; i < 5; i++) recordSend(p, { now: now - 1000 * i, conversation: "live" });

  checkCaps(p, { now, conversation: "live" });

  assert.equal(fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length, 5);
});
