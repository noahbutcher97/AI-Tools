import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { serializeReceipt, writeInstallReceipt } from "./lib/receipt.mjs";

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "receipt-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install receipts", () => {
  it("serializes non-secret run state", () => {
    const receipt = serializeReceipt({
      mode: "install",
      workspace: "D:/Example",
      aiToolsRoot: "D:/DevTools/AI-Tools",
      selectedBridges: ["atlassian"],
      exitCode: 1,
      files: { publicConfig: "D:/Example/.mcp.json" },
      bridgeResults: [{
        bridge: "atlassian",
        requested: true,
        status: "failed",
        severity: "error",
        stages: {
          credentials: {
            secretFields: [{ name: "ATLASSIAN_API_TOKEN", value: "secret-token", present: true }],
          },
        },
      }],
      nextSteps: ["Re-run installer."],
    });

    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes("secret-token"), false);
    assert.equal(receipt.schemaVersion, "1.0");
    assert.equal(receipt.summary.byStatus.failed, 1);
    assert.equal(receipt.bridgeResults[0].stages.credentials.secretFields[0].present, true);
    assert.equal("value" in receipt.bridgeResults[0].stages.credentials.secretFields[0], false);
  });

  it("redacts token values in action strings", () => {
    const receipt = serializeReceipt({
      mode: "install",
      workspace: "D:/Example",
      aiToolsRoot: "D:/DevTools/AI-Tools",
      selectedBridges: ["atlassian"],
      exitCode: 1,
      bridgeResults: [{
        bridge: "atlassian",
        requested: true,
        status: "partial",
        severity: "warning",
        actions: ["Retry with ATLASSIAN_API_TOKEN=secret-token."],
      }],
    });

    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes("secret-token"), false);
    assert.equal(serialized.includes("[redacted]"), true);
  });

  it("writes a timestamped receipt file", () => withTempWorkspace((dir) => {
    const written = writeInstallReceipt(dir, {
      mode: "install",
      workspace: dir,
      aiToolsRoot: "D:/DevTools/AI-Tools",
      selectedBridges: [],
      exitCode: 0,
      files: {},
      bridgeResults: [],
      nextSteps: [],
    });

    assert.equal(existsSync(written.path), true);
    assert.match(written.path, /\.mcp-install-receipts/);
    assert.match(basename(written.path), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}-install\.json$/);
    const data = JSON.parse(readFileSync(written.path, "utf-8"));
    assert.equal(data.mode, "install");
  }));

  it("generates unique receipt names for repeated writes", () => withTempWorkspace((dir) => {
    const input = {
      mode: "install",
      workspace: dir,
      aiToolsRoot: "D:/DevTools/AI-Tools",
      selectedBridges: [],
      exitCode: 0,
      files: {},
      bridgeResults: [],
      nextSteps: [],
      startedAt: "2026-05-31T18:52:49.471Z",
    };

    const first = writeInstallReceipt(dir, input);
    const second = writeInstallReceipt(dir, input);

    assert.notEqual(first.path, second.path);
    assert.equal(existsSync(first.path), true);
    assert.equal(existsSync(second.path), true);
  }));

  it("keeps doctorSummary to a safe structured summary", () => {
    const receipt = serializeReceipt({
      mode: "doctor",
      workspace: "D:/Example",
      aiToolsRoot: "D:/DevTools/AI-Tools",
      selectedBridges: [],
      exitCode: 1,
      bridgeResults: [],
      doctorSummary: {
        exitCode: 1,
        issueCodes: ["uemcp-version-mismatch"],
        totalIssues: 1,
        issuesBySeverity: { warning: 1, "bad key with secret": 2 },
        bridgeStatuses: { uemcp: 1, "bad status secret": 1 },
        status: "warning",
        summary: "raw secret value should not be serialized",
        rawOutput: "raw secret value should not be serialized",
        token: "secret-token",
      },
    });

    const serialized = JSON.stringify(receipt);
    assert.equal(receipt.doctorSummary.exitCode, 1);
    assert.equal(receipt.doctorSummary.totalIssues, 1);
    assert.equal(receipt.doctorSummary.issuesBySeverity.warning, 1);
    assert.equal(receipt.doctorSummary.bridgeStatuses.uemcp, 1);
    assert.deepEqual(receipt.doctorSummary.issueCodes, ["uemcp-version-mismatch"]);
    assert.equal(serialized.includes("raw secret value"), false);
    assert.equal(serialized.includes("bad key with secret"), false);
    assert.equal(serialized.includes("bad status secret"), false);
    assert.equal(serialized.includes("secret-token"), false);
  });
});
