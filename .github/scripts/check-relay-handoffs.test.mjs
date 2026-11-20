import assert from "node:assert/strict";
import test from "node:test";
import { checkHandoffs } from "./check-relay-handoffs.mjs";

test("an assigned worker can return findings for the coordinator to accept", () => {
  const r = { id: "fixture", revision: "a".repeat(40), worker: "reviewer", coordinator: "lead",
    scope: "read only", acceptance: "inspect boundary", state: "assigned" };
  checkHandoffs([r]);
  assert.throws(() => checkHandoffs([r, r]));
  r.state = "returned";
  assert.throws(() => checkHandoffs([r]));
  r.result = { revision: "b".repeat(40), verdict: "hold", evidence: "source inspection", limitations: "offline" };
  assert.throws(() => checkHandoffs([r]));
  r.result.revision = r.revision;
  checkHandoffs([r]);
  r.state = "accepted";
  assert.throws(() => checkHandoffs([r]));
  r.acknowledgment = { by: "reviewer", disposition: "findings open", next: "fix and review" };
  assert.throws(() => checkHandoffs([r]));
  r.acknowledgment.by = "lead";
  checkHandoffs([r]);
});
