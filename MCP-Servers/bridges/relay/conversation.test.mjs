import assert from "node:assert/strict";
import { test } from "node:test";

import { conversationVerdict, mintConversationId, parseConversationId } from "./client.mjs";

const ORIGIN = "01a034fa-7e07-7c71-a58f-4d49569c1636";
const OTHER = "2ed73e8c-517a-4786-b8fb-9f80f35c90fc";

test("a minted id carries the verified origin after an @", () => {
  assert.equal(mintConversationId(ORIGIN, "4b2c9f1a"), `c-4b2c9f1a@${ORIGIN}`);
});

test("a minted id with no verified origin has no @ part", () => {
  assert.equal(mintConversationId(null, "4b2c9f1a"), "c-4b2c9f1a");
});

test("two mints from one session differ", () => {
  assert.notEqual(mintConversationId(ORIGIN), mintConversationId(ORIGIN));
});

test("the random part is 8 lowercase hex", () => {
  assert.match(mintConversationId(null), /^c-[0-9a-f]{8}$/);
});

test("parsing recovers the whole origin, not a prefix", () => {
  // Origins are uuids and contain dashes, so a dash-delimited encoding could
  // not be split back apart. Truncating instead would force prefix matching,
  // which collides between sessions sharing a prefix.
  const parsed = parseConversationId(`c-4b2c9f1a@${ORIGIN}`);

  assert.equal(parsed.openedBy, ORIGIN);
  assert.equal(parsed.random, "4b2c9f1a");
});

test("parsing splits on the first @, not the last", () => {
  const parsed = parseConversationId("c-4b2c9f1a@name@with@ats");

  assert.equal(parsed.openedBy, "name@with@ats");
});

test("an id with no @ parses with a null origin", () => {
  assert.deepEqual(parseConversationId("c-4b2c9f1a"), { random: "4b2c9f1a", openedBy: null });
});

test("a non-relay id parses as null rather than throwing", () => {
  // Spec section 8: an unparseable conversation id is an opaque claim, never a
  // crash and never a rejection.
  assert.equal(parseConversationId("something-else-entirely"), null);
  assert.equal(parseConversationId(null), null);
  assert.equal(parseConversationId(""), null);
});

// ── Attestation verdicts ──

test("a sender continuing their own conversation is told so", () => {
  const v = conversationVerdict(`c-4b2c9f1a@${ORIGIN}`, ORIGIN);

  assert.equal(v.code, "opened_by_you");
});

test("a reply from the other party is not rendered as a problem", () => {
  // Spec section 8: this is the ORDINARY reply case. Rendering it as a warning
  // would make every successful reply look suspicious.
  const v = conversationVerdict(`c-4b2c9f1a@${ORIGIN}`, OTHER);

  assert.equal(v.code, "opened_by_other");
  assert.doesNotMatch(v.text, /warning|suspicious|mismatch/i);
  assert.match(v.text, new RegExp(ORIGIN));
});

test("a conversation opened without proof is distinct from an unverifiable sender", () => {
  // These are opposite absences and were nearly collapsed in the design. One is
  // a conversation OPENED without proof; the other is a sender who cannot prove
  // who they are NOW.
  const openedUnverified = conversationVerdict("c-4b2c9f1a", ORIGIN);
  const senderUnverifiable = conversationVerdict(`c-4b2c9f1a@${ORIGIN}`, null);

  assert.equal(openedUnverified.code, "opened_unverified");
  assert.equal(senderUnverifiable.code, "sender_unverifiable");
  assert.notEqual(openedUnverified.code, senderUnverifiable.code);
});

test("a verified sender replying into an unverifiably-opened conversation reports the conversation's absence", () => {
  // Reporting this as sender_unverifiable would understate what is known: this
  // sender IS verified.
  const v = conversationVerdict("c-4b2c9f1a", ORIGIN);

  assert.equal(v.code, "opened_unverified");
});

test("an unparseable conversation id is treated as an opaque claim", () => {
  const v = conversationVerdict("not-a-relay-id", ORIGIN);

  assert.equal(v.code, "sender_unverifiable");
  assert.equal(typeof v.text, "string");
});
