import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToText } from "./html-text.mjs";

// Confluence page bodies and Miro item content both arrive as HTML. Reading
// either previously meant stripping markup on the caller's side — one audit
// wrote throwaway Python for two pages of 404,787 and 266,366 characters.
// Confluence macro and resource wrappers are the bulk of that weight, and on a
// sampled page stripping cut 12,964 characters to 3,055.
//
// One implementation, shared, so the two bridges cannot drift apart.

test("removes tags and returns the readable text", () => {
  assert.equal(htmlToText("<p>Milestone 2</p><p>(August 10 - September 2)</p>"), "Milestone 2 (August 10 - September 2)");
});

test("drops Confluence macro wrappers entirely, including their contents", () => {
  // <ac:*> wraps attachments, images and macros — the bulk of a large page.
  const html = "<p>Before</p><ac:structured-macro><ac:parameter>noise</ac:parameter></ac:structured-macro><p>After</p>";
  assert.equal(htmlToText(html), "Before After");
});

test("drops self-closing resource identifiers", () => {
  assert.equal(htmlToText('<p>See</p><ri:attachment ri:filename="big.png"/><p>this</p>'), "See this");
});

test("decodes the entities that survive stripping", () => {
  assert.equal(htmlToText("<p>Tools&nbsp;&amp;&nbsp;Tech &lt;beta&gt;</p>"), "Tools & Tech <beta>");
});

test("collapses whitespace so output is one clean run", () => {
  assert.equal(htmlToText("<p>a</p>\n\n   <p>b</p>\t<p>c</p>"), "a b c");
});

test("returns an empty string for empty or missing input rather than throwing", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
});

test("leaves plain text untouched", () => {
  assert.equal(htmlToText("already plain"), "already plain");
});

test("does not mistake a less-than sign in prose for a tag", () => {
  // Real page text contains comparisons. Entity-encoded input must survive.
  assert.equal(htmlToText("<p>latency &lt; 16ms</p>"), "latency < 16ms");
});

test("keeps block boundaries as spaces so words do not run together", () => {
  // The failure this guards: "<li>one</li><li>two</li>" becoming "onetwo".
  assert.equal(htmlToText("<li>one</li><li>two</li>"), "one two");
});

// ── extractSection ──
//
// Pulling one heading's subtree out of a page. Verified against real Confluence
// storage format, which uses plain <h1>..<h6> tags. A real page in the sample
// carries two near-identical headings ("Auras" and "Auras " with trailing
// whitespace), so matching has to be whitespace-tolerant and has to tell the
// caller when a title was ambiguous rather than silently picking one.

import { extractSection } from "./html-text.mjs";

const DOC = [
  "<h2>Magic</h2><p>intro</p>",
  "<h3>What Magic Does</h3><p>nested detail</p>",
  "<h2>Grimoires</h2><p>grimoire body</p>",
  "<h2>Auras </h2><p>first auras</p>",
  "<h2>Auras</h2><p>second auras</p>",
].join("");

test("extractSection returns a heading's own content", () => {
  const r = extractSection(DOC, "Grimoires");
  assert.match(r.html, /grimoire body/);
  assert.ok(!/intro/.test(r.html), "must not bleed into the previous section");
});

test("extractSection stops at the next heading of the same level", () => {
  const r = extractSection(DOC, "Grimoires");
  assert.ok(!/first auras/.test(r.html), "must not run past the next h2");
});

test("extractSection includes nested subsections of a deeper level", () => {
  const r = extractSection(DOC, "Magic");
  assert.match(r.html, /nested detail/, "an h3 under an h2 belongs to that h2");
  assert.ok(!/grimoire body/.test(r.html), "but the next h2 does not");
});

test("extractSection matches a heading ignoring surrounding whitespace", () => {
  const r = extractSection(DOC, "Auras");
  assert.ok(r.found);
});

test("extractSection reports an ambiguous title instead of silently guessing", () => {
  // "Auras " and "Auras" both exist on a real page in this space.
  const r = extractSection(DOC, "Auras");
  assert.equal(r.matchCount, 2);
  assert.match(r.ambiguous, /more than one|ambiguous|2/i);
});

test("extractSection says plainly when a heading is not present", () => {
  const r = extractSection(DOC, "Nonexistent");
  assert.equal(r.found, false);
  assert.deepEqual(r.availableHeadings.slice(0, 2), ["Magic", "What Magic Does"]);
});

test("extractSection lists available headings so a caller can retry", () => {
  const r = extractSection(DOC, "typo");
  assert.ok(r.availableHeadings.includes("Grimoires"));
});

test("extractSection handles a document with no headings at all", () => {
  const r = extractSection("<p>just prose</p>", "Anything");
  assert.equal(r.found, false);
  assert.deepEqual(r.availableHeadings, []);
});
