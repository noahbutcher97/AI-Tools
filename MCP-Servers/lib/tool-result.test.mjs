import assert from "node:assert/strict";
import { test } from "node:test";

import { toolJsonResult, toolListResult } from "./tool-result.mjs";

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// A list response whose length happens to equal its limit is indistinguishable
// from a complete one. That ambiguity produced three separate wrong conclusions
// in a cross-surface audit: a truncated page of Confluence pages read as the
// whole space, a capped page of Miro items read as the whole board, and a bulk
// key lookup's omissions read as deletions.
//
// The fix is a shape every list-returning tool shares, in which stating
// completeness is mandatory rather than optional. See
// docs/superpowers/plans/2026-08-17-mcp-bridge-audit-remediation.md.

test("toolListResult requires an explicit isLast", () => {
  assert.throws(
    () => toolListResult([1, 2, 3], {}),
    /isLast/,
    "a list result must not be constructible without stating completeness",
  );
});

test("toolListResult accepts isLast false without complaint", () => {
  const body = parse(toolListResult([1, 2], { isLast: false }));
  assert.equal(body.isLast, false);
});

test("toolListResult reports count from the items themselves", () => {
  const body = parse(toolListResult(["a", "b", "c"], { isLast: true }));
  assert.equal(body.count, 3);
  assert.deepEqual(body.items, ["a", "b", "c"]);
});

test("toolListResult defaults total to null rather than inventing one", () => {
  // Deriving a total from a page length is exactly the fabrication that makes a
  // truncated result look complete.
  const body = parse(toolListResult([1, 2, 3], { isLast: true }));
  assert.equal(body.total, null);
  assert.ok("total" in body, "total must be present and explicitly null, not omitted");
});

test("toolListResult carries a real total when the upstream API supplies one", () => {
  const body = parse(toolListResult([1, 2], { isLast: false, total: 264 }));
  assert.equal(body.total, 264);
});

test("toolListResult rejects a total smaller than the page it describes", () => {
  assert.throws(
    () => toolListResult([1, 2, 3], { isLast: true, total: 2 }),
    /total/,
    "a total below the returned count is incoherent and would mislead",
  );
});

test("toolListResult surfaces a server-side cap as truncation", () => {
  const body = parse(toolListResult([1, 2], { isLast: false, truncated: "stopped at max=2" }));
  assert.equal(body.truncated, "stopped at max=2");
});

test("toolListResult rejects claiming both complete and truncated", () => {
  assert.throws(
    () => toolListResult([1], { isLast: true, truncated: "stopped at max=1" }),
    /isLast|truncat/i,
    "a truncated result is by definition not the last page",
  );
});

test("toolListResult passes through scope and warning for unscoped queries", () => {
  const body = parse(
    toolListResult([1], { isLast: true, scope: "all-users", warning: "reaches beyond you" }),
  );
  assert.equal(body.scope, "all-users");
  assert.equal(body.warning, "reaches beyond you");
});

test("toolListResult omits optional fields that were not supplied", () => {
  const body = parse(toolListResult([], { isLast: true }));
  assert.ok(!("scope" in body));
  assert.ok(!("warning" in body));
  assert.ok(!("truncated" in body));
});

test("toolListResult names the item collection when asked", () => {
  // Some tools read better with a domain name than a generic "items".
  const body = parse(toolListResult([{ key: "PO" }], { isLast: true, itemsKey: "spaces" }));
  assert.deepEqual(body.spaces, [{ key: "PO" }]);
  assert.ok(!("items" in body));
  assert.equal(body.count, 1);
});

test("toolJsonResult still behaves as before", () => {
  // Regression guard: the existing helper is used by every bridge.
  assert.deepEqual(parse(toolJsonResult({ a: 1 })), { a: 1 });
});

test("toolListResult carries tool-specific metadata without weakening its rules", () => {
  // Some tools must report a boundary the envelope does not model — e.g. a
  // Perforce sweep is bounded by a depot, so "complete" means complete for that
  // depot and a caller has to be able to see which.
  const body = parse(
    toolListResult([1], { isLast: true, extra: { depotScope: "//Depot/Project/..." } }),
  );
  assert.equal(body.depotScope, "//Depot/Project/...");
  assert.equal(body.isLast, true);
});

test("toolListResult does not let extra metadata overwrite the completeness fields", () => {
  // Otherwise a tool could quietly restore the ambiguity the helper prevents.
  assert.throws(
    () => toolListResult([1, 2], { isLast: false, extra: { isLast: true, total: 999 } }),
    /extra/i,
  );
});
