// Unit tests for resolveBridgeConfig — focused on tier-1 (env) behavior
// since that's what the descriptor-aware fix targets. Tiers 2/3 are
// filesystem-dependent and exercised in practice by every bridge that
// starts up against a .mcp.json; not unit-tested here.
//
// Run with: `node --test` from MCP-Servers/lib/

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveBridgeConfig } from "./resolve-config.mjs";

// Snapshot every env var the resolver might read and restore between tests.
// PROJECT_ROOT is forced unset to keep tier 2 from accidentally engaging
// on developer machines where the var happens to be defined.
const ENV_KEYS = ["TEST_REQUIRED_A", "TEST_REQUIRED_B", "TEST_OPTIONAL", "PROJECT_ROOT"];
let snapshot;

function quietLogger() { /* no-op; keeps test output clean */ }

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("resolveBridgeConfig — tier 1 env resolution with descriptors", () => {
  it("returns env source when all required fields are present (optional absent)", () => {
    process.env.TEST_REQUIRED_A = "valueA";
    process.env.TEST_REQUIRED_B = "valueB";

    const result = resolveBridgeConfig(
      "test-bridge",
      [
        { name: "TEST_REQUIRED_A", required: true },
        { name: "TEST_REQUIRED_B", required: true },
        { name: "TEST_OPTIONAL", required: false },
      ],
      { logger: quietLogger },
    );

    assert.deepEqual(result, {
      values: { TEST_REQUIRED_A: "valueA", TEST_REQUIRED_B: "valueB" },
      source: "env",
    });
  });

  it("includes optional fields in values when they ARE present in env", () => {
    process.env.TEST_REQUIRED_A = "valueA";
    process.env.TEST_REQUIRED_B = "valueB";
    process.env.TEST_OPTIONAL = "extraValue";

    const result = resolveBridgeConfig(
      "test-bridge",
      [
        { name: "TEST_REQUIRED_A", required: true },
        { name: "TEST_REQUIRED_B", required: true },
        { name: "TEST_OPTIONAL", required: false },
      ],
      { logger: quietLogger },
    );

    assert.deepEqual(result.values, {
      TEST_REQUIRED_A: "valueA",
      TEST_REQUIRED_B: "valueB",
      TEST_OPTIONAL: "extraValue",
    });
    assert.equal(result.source, "env");
  });

  it("falls through (returns null) when a REQUIRED field is missing", () => {
    process.env.TEST_REQUIRED_A = "valueA";
    // TEST_REQUIRED_B intentionally absent

    const result = resolveBridgeConfig(
      "test-bridge",
      [
        { name: "TEST_REQUIRED_A", required: true },
        { name: "TEST_REQUIRED_B", required: true },
        { name: "TEST_OPTIONAL", required: false },
      ],
      { logger: quietLogger },
    );

    // Tier 2 / 3 won't find anything in test env, so null is expected.
    assert.equal(result, null);
  });

  it("treats empty-string env vars as absent (matches existing behavior)", () => {
    process.env.TEST_REQUIRED_A = "valueA";
    process.env.TEST_REQUIRED_B = ""; // empty string — should NOT count as set

    const result = resolveBridgeConfig(
      "test-bridge",
      [
        { name: "TEST_REQUIRED_A", required: true },
        { name: "TEST_REQUIRED_B", required: true },
      ],
      { logger: quietLogger },
    );

    assert.equal(result, null);
  });

  it("does NOT claim env source when every field is optional and none are set", () => {
    // Degenerate case: all-optional manifest with nothing in env. Returning
    // an empty env source would shadow tier 2/3 inappropriately.
    const result = resolveBridgeConfig(
      "test-bridge",
      [{ name: "TEST_OPTIONAL", required: false }],
      { logger: quietLogger },
    );

    assert.equal(result, null);
  });

  it("claims env source for all-optional manifest when at least one is set", () => {
    process.env.TEST_OPTIONAL = "optValue";

    const result = resolveBridgeConfig(
      "test-bridge",
      [{ name: "TEST_OPTIONAL", required: false }],
      { logger: quietLogger },
    );

    assert.deepEqual(result, {
      values: { TEST_OPTIONAL: "optValue" },
      source: "env",
    });
  });
});

describe("resolveBridgeConfig — backward compatibility with legacy string[] fields", () => {
  it("treats every string-form field as required (preserves pre-fix behavior)", () => {
    process.env.TEST_REQUIRED_A = "valueA";
    // TEST_REQUIRED_B and TEST_OPTIONAL absent — under string-form, ALL must
    // be present for tier 1 to win. So this should fall through.

    const result = resolveBridgeConfig(
      "test-bridge",
      ["TEST_REQUIRED_A", "TEST_REQUIRED_B", "TEST_OPTIONAL"],
      { logger: quietLogger },
    );

    assert.equal(result, null);
  });

  it("returns env source when ALL string-form fields are present", () => {
    process.env.TEST_REQUIRED_A = "a";
    process.env.TEST_REQUIRED_B = "b";
    process.env.TEST_OPTIONAL = "c";

    const result = resolveBridgeConfig(
      "test-bridge",
      ["TEST_REQUIRED_A", "TEST_REQUIRED_B", "TEST_OPTIONAL"],
      { logger: quietLogger },
    );

    assert.deepEqual(result, {
      values: { TEST_REQUIRED_A: "a", TEST_REQUIRED_B: "b", TEST_OPTIONAL: "c" },
      source: "env",
    });
  });

  it("accepts a mixed array of strings and descriptors", () => {
    process.env.TEST_REQUIRED_A = "a";
    process.env.TEST_REQUIRED_B = "b";
    // TEST_OPTIONAL absent — given as descriptor with required:false

    const result = resolveBridgeConfig(
      "test-bridge",
      [
        "TEST_REQUIRED_A",
        "TEST_REQUIRED_B",
        { name: "TEST_OPTIONAL", required: false },
      ],
      { logger: quietLogger },
    );

    assert.deepEqual(result, {
      values: { TEST_REQUIRED_A: "a", TEST_REQUIRED_B: "b" },
      source: "env",
    });
  });
});
