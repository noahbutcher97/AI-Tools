import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBridgeResult,
  setStage,
  addAction,
  finalizeBridgeResult,
  summarizeResults,
  exitCodeForResults,
  validateRequestedBridges,
  redactBridgeResult,
  formatInstallSummary,
} from "./lib/install-results.mjs";

describe("install result exit codes", () => {
  it("returns exit 0 when selected bridges are ok", () => {
    const perforce = createBridgeResult("perforce", { requested: true });
    const jira = createBridgeResult("jira", { requested: true });

    finalizeBridgeResult(perforce, "ok");
    finalizeBridgeResult(jira, "ok");

    assert.equal(exitCodeForResults([perforce, jira]), 0);
  });

  it("returns exit 1 when any selected bridge is partial", () => {
    const perforce = createBridgeResult("perforce", { requested: true });
    const jira = createBridgeResult("jira", { requested: true });

    finalizeBridgeResult(perforce, "ok");
    finalizeBridgeResult(jira, "partial");

    assert.equal(exitCodeForResults([perforce, jira]), 1);
  });

  it("returns exit 1 when any selected bridge fails", () => {
    const perforce = createBridgeResult("perforce", { requested: true });
    const jira = createBridgeResult("jira", { requested: true });

    finalizeBridgeResult(perforce, "failed");
    finalizeBridgeResult(jira, "ok");

    assert.equal(exitCodeForResults([perforce, jira]), 1);
  });

  it("returns exit 1 when any previously enabled bridge fails", () => {
    const result = finalizeBridgeResult(createBridgeResult("x", { previouslyEnabled: true }), "failed");

    assert.equal(exitCodeForResults([result]), 1);
  });

  it("returns exit 2 for usage errors", () => {
    assert.equal(exitCodeForResults([], { usageError: true }), 2);
  });
});

describe("install result finalization", () => {
  it("throws for invalid result statuses", () => {
    assert.throws(
      () => finalizeBridgeResult(createBridgeResult("x"), "faild"),
      /Invalid result status/,
    );
  });

  it("de-dupes actions", () => {
    const result = createBridgeResult("x");

    addAction(result, "Run doctor");
    addAction(result, "Run doctor");

    assert.deepEqual(result.actions, ["Run doctor"]);
  });
});

describe("requested bridge validation", () => {
  it("returns exit 2 for unknown requested bridges", () => {
    const result = validateRequestedBridges(["perforce", "bogus"], { bridges: { perforce: {} } });

    assert.deepEqual(result, {
      ok: false,
      unknown: ["bogus"],
      exitCode: 2,
    });
  });
});

describe("install result redaction", () => {
  it("removes secret field values from stages while preserving public field values and secret field name/present", () => {
    const result = createBridgeResult("perforce", { requested: true, previouslyEnabled: true });
    setStage(result, "collect", {
      publicFields: [
        { name: "P4USER", value: "alice", present: true },
      ],
      secretFields: [
        { name: "P4PASSWD", value: "super-secret", present: true },
      ],
      nested: {
        apiToken: "token-secret",
        publicValue: "visible",
      },
    });

    const redacted = redactBridgeResult(result);

    assert.equal(redacted.stages.collect.publicFields[0].value, "alice");
    assert.equal(redacted.stages.collect.secretFields[0].name, "P4PASSWD");
    assert.equal(redacted.stages.collect.secretFields[0].present, true);
    assert.equal("value" in redacted.stages.collect.secretFields[0], false);
    assert.equal(redacted.stages.collect.nested.apiToken, "[redacted]");
    assert.equal(redacted.stages.collect.nested.publicValue, "visible");
  });

  it("redacts action string content containing token or password assignments", () => {
    const result = createBridgeResult("atlassian", { requested: true });
    addAction(result, "Retry with ATLASSIAN_API_TOKEN=abc123 and password: hunter2");

    const redacted = redactBridgeResult(result);

    assert.equal(redacted.actions[0].includes("abc123"), false);
    assert.equal(redacted.actions[0].includes("hunter2"), false);
    assert.match(redacted.actions[0], /ATLASSIAN_API_TOKEN=\[redacted\]/);
    assert.match(redacted.actions[0], /password: \[redacted\]/);
  });

  it("redacts quoted and spaced action secret values as one unit", () => {
    const result = createBridgeResult("perforce", { requested: true });
    addAction(result, "Retry with password: \"hunter two\"");
    addAction(result, "Set token='abc def'");
    addAction(result, "Set ATLASSIAN_API_TOKEN=secret-token");
    addAction(result, "Set P4PASSWD=my password");

    const redacted = redactBridgeResult(result);
    const receipt = redacted.actions.join("\n");

    assert.equal(receipt.includes("hunter"), false);
    assert.equal(receipt.includes("two"), false);
    assert.equal(receipt.includes("abc def"), false);
    assert.equal(receipt.includes("secret-token"), false);
    assert.equal(receipt.includes("my password"), false);
  });
});

describe("install result summaries", () => {
  it("summarizes totals by status and severity", () => {
    const perforce = createBridgeResult("perforce", { requested: true });
    const jira = createBridgeResult("jira");

    finalizeBridgeResult(perforce, "ok", { severity: "info" });
    finalizeBridgeResult(jira, "skipped", { severity: "info" });

    assert.deepEqual(summarizeResults([perforce, jira]), {
      total: 2,
      byStatus: { ok: 1, skipped: 1 },
      bySeverity: { info: 2 },
    });
  });

  it("does not include secret-bearing token or password values from actions", () => {
    const result = createBridgeResult("atlassian", { requested: true });
    finalizeBridgeResult(result, "failed", {
      actions: [
        "Check token=abc123",
        "Reset P4PASSWD=super-secret",
      ],
    });

    const summary = formatInstallSummary([result], 1);

    assert.equal(summary.includes("abc123"), false);
    assert.equal(summary.includes("super-secret"), false);
    assert.match(summary, /token=\[redacted\]/);
    assert.match(summary, /P4PASSWD=\[redacted\]/);
  });

  it("does not include quoted or spaced secret values from actions", () => {
    const result = createBridgeResult("atlassian", { requested: true });
    finalizeBridgeResult(result, "failed", {
      actions: [
        "Retry with password: \"hunter two\"",
        "Set token='abc def'",
        "Set ATLASSIAN_API_TOKEN=secret-token",
      ],
    });

    const summary = formatInstallSummary([result], 1);

    assert.equal(summary.includes("hunter"), false);
    assert.equal(summary.includes("two"), false);
    assert.equal(summary.includes("abc def"), false);
    assert.equal(summary.includes("secret-token"), false);
  });
});
