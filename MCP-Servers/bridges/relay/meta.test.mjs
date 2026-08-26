import assert from "node:assert/strict";
import { test } from "node:test";

import { RELAY_META_PREFIX, buildMetaLine } from "./client.mjs";

function parse(line) {
  return JSON.parse(line.slice(RELAY_META_PREFIX.length));
}

test("the header is one physical line", () => {
  // A recipient finds the line beginning RELAY-META and JSON-parses the rest.
  // A header split across lines would not parse at all.
  const line = buildMetaLine({
    kind: "request",
    conversation: "c-4b2c9f1a@01a034fa-7e07-7c71-a58f-4d49569c1636",
    messageId: "m-6f21a0",
    inReplyTo: null,
    from: { id: "2ed73e8c", provider: "claude", verified: true },
  });

  assert.equal(line.includes("\n"), false);
  assert.equal(line.startsWith(RELAY_META_PREFIX), true);
});

test("the header carries a schema version from the first release", () => {
  assert.equal(parse(buildMetaLine({})).v, 1);
});

test("kind defaults to notice", () => {
  assert.equal(parse(buildMetaLine({})).kind, "notice");
});

test("every field round-trips through JSON", () => {
  const meta = parse(
    buildMetaLine({
      kind: "reply",
      conversation: "c-4b2c9f1a@origin",
      messageId: "m-abc123",
      inReplyTo: "m-6f21a0",
      from: { id: "2ed73e8c", provider: "claude", verified: true },
    }),
  );

  assert.equal(meta.kind, "reply");
  assert.equal(meta.conversation, "c-4b2c9f1a@origin");
  assert.equal(meta.message_id, "m-abc123");
  assert.equal(meta.in_reply_to, "m-6f21a0");
  assert.deepEqual(meta.from, { id: "2ed73e8c", provider: "claude", verified: true });
});

test("an unverified sender carries the claim, never a fabricated id", () => {
  // Spec section 4: the field is only as good as the flag beside it.
  const meta = parse(buildMetaLine({ from: { id: "i-say-i-am-bob", provider: null, verified: false } }));

  assert.equal(meta.from.verified, false);
  assert.equal(meta.from.id, "i-say-i-am-bob");
});

test("a sender claiming nothing carries null, not an empty string", () => {
  const meta = parse(buildMetaLine({ from: { id: null, provider: null, verified: false } }));

  assert.equal(meta.from.id, null);
});

test("a multi-line value cannot break the header onto a second line", () => {
  // JSON.stringify escapes newlines rather than emitting them, which is what
  // keeps this to one physical line whatever it is given.
  const line = buildMetaLine({ conversation: "c-4b2c9f1a@a\nb" });

  assert.equal(line.includes("\n"), false);
});
