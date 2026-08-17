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
