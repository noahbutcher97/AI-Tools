import assert from "node:assert/strict";
import { test } from "node:test";

import { mintConversationId, parseConversationId } from "./client.mjs";

const ORIGIN = "01a034fa-7e07-7c71-a58f-4d49569c1636";

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
