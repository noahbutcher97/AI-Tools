// Bounding runaway exchanges (spec 4.7).
//
// Delivery wakes a fully idle session with no human input, and every delivered
// message costs a model turn in the recipient. Once the Codex direction gained
// a verified reply address, two agents could sustain an exchange indefinitely.
// The missing address had been suppressing that BY ACCIDENT; this replaces the
// accident with something deliberate.
//
// The threat is an ACCIDENTAL loop, not a malicious one: two agents politely
// acknowledging each other overnight is the realistic failure. An adversary who
// can spawn processes already defeats the identity model outright, so hardening
// these caps against one would cost legitimate use and buy nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONVERSATION_CAP = 20;
export const HOURLY_CAP = 200;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ALWAYS the temp directory, never the user profile.
//
// Measured 2026-08-27, and narrower than it first looks: a Codex-spawned relay
// MCP SERVER writes under the user profile fine. It is the CLI face that is
// sandboxed, running in the session shell under workspace-write. This file is
// written by BOTH faces, so it has to live where the more restricted one can
// write.
//
// TEMP and TMP are among the eighteen variables Codex passes to its MCP
// servers, so both providers resolve the same path. A counter split across two
// files by provider is worse than no counter, because it reports a bound it is
// not enforcing.
export function ledgerPath() {
  return path.join(os.tmpdir(), "cross-agent-relay-ledger.log");
}

// Appends are atomic at this size and counting is a read, so no lock protocol is
// needed. A race over-counts rather than under-counts, which errs toward
// refusing — the safe direction for a cost guard.
export function recordSend(ledger, { now, conversation }) {
  try {
    fs.appendFileSync(ledger, `${JSON.stringify({ t: now, c: conversation ?? null })}\n`);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error && error.message) };
  }
}

function readEntries(ledger, now) {
  const raw = fs.readFileSync(ledger, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.t === "number" && now - entry.t <= RETENTION_MS) entries.push(entry);
    } catch {
      // One corrupt line must not blind the counter to every other line.
    }
  }
  return entries;
}

export function checkCaps(ledger, { now, conversation }) {
  let entries;
  try {
    entries = readEntries(ledger, now);
  } catch {
    // Fails open, LOUDLY: the caller reports the guard inoperative rather than
    // refusing every send over a broken counter file, which would cause the
    // outage the counter exists to prevent.
    return { allowed: true, inoperative: true, cause: null, detail: null };
  }

  // Retention is 24h while the window below is 1h, so this counts every
  // retained entry: a loop slow enough to stay under an hourly threshold must
  // not be able to reset its own conversation count by waiting.
  if (conversation) {
    const inConversation = entries.filter((entry) => entry.c === conversation).length;
    if (inConversation >= CONVERSATION_CAP) {
      return {
        allowed: false,
        inoperative: false,
        cause: "exchange_capped",
        detail:
          `conversation ${conversation} has reached its ${CONVERSATION_CAP}-message cap. ` +
          "If this exchange is genuinely longer, open a new conversation deliberately rather than by accident.",
      };
    }
  }

  // Applies whether or not a conversation was named, so omitting the id is not
  // a way past both caps.
  const recent = entries.filter((entry) => now - entry.t <= HOUR_MS).length;
  if (recent >= HOURLY_CAP) {
    return {
      allowed: false,
      inoperative: false,
      cause: "exchange_capped",
      detail:
        `relay has sent ${recent} messages in the last hour, at the ${HOURLY_CAP}-per-hour machine-wide cap. ` +
        "Something is looping; check the spool before raising it.",
    };
  }

  return { allowed: true, inoperative: false, cause: null, detail: null };
}
