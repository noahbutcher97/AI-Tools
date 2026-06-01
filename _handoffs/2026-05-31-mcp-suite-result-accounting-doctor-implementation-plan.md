# MCP Suite Result Accounting And Doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented in commit `1965686` (`installer: add result accounting doctor`). This file is retained as the implementation plan and acceptance reference; unchecked task boxes below are historical plan text, not current open work.

**Goal:** Add truthful install/update result accounting and an expanded read-only doctor that catches malformed config, missing server paths, missing required fields, stale bridge versions, and the current UEMCP server/plugin drift.

**Architecture:** Keep `install.mjs` as the CLI orchestrator, but move reusable logic into focused ESM modules under `Installers/MCP-Suite/Scripts/lib/`. Tests target pure modules first, then the CLI wiring. Doctor and install summaries use the same result/status vocabulary so their claims cannot drift.

**Tech Stack:** Node 18+ ESM, `node:test`, PowerShell verification commands, existing AI-Tools installer helpers.

---

## Scope Guard

This plan implements the design in `_handoffs/2026-05-31-mcp-suite-result-accounting-doctor-design.md`.

Do not implement:

- Codex config generation.
- global Codex MCP cleanup.
- live MCP client discovery.
- remote bridge cache identity by tag/SHA.
- full UEMCP setup parity.
- automatic `.uproject` mutation.
- network checks from doctor.
- secret values in logs, doctor output, receipts, or tests.

The repo currently has unrelated dirty files. Stage only files named in this plan if the user later asks for a commit.

## File Map

Create:

- `Installers/MCP-Suite/Scripts/lib/install-results.mjs`
- `Installers/MCP-Suite/Scripts/lib/doctor.mjs`
- `Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs`
- `Installers/MCP-Suite/Scripts/lib/receipt.mjs`
- `Installers/MCP-Suite/Scripts/install-results.test.mjs`
- `Installers/MCP-Suite/Scripts/doctor.test.mjs`
- `Installers/MCP-Suite/Scripts/uemcp-doctor.test.mjs`
- `Installers/MCP-Suite/Scripts/receipt.test.mjs`

Modify:

- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs`
- `Installers/MCP-Suite/Scripts/mcp-config.test.mjs`
- `Installers/MCP-Suite/Scripts/install.mjs`

No bridge runtime files are part of this slice.

## Task 1: Config Parse Safety

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs`
- Modify: `Installers/MCP-Suite/Scripts/mcp-config.test.mjs`

- [ ] **Step 1: Add failing parse-status tests**

Extend imports in `mcp-config.test.mjs`:

```js
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setBridgeInConfig,
  disableBridgeInConfig,
  loadWorkspaceConfig,
  assertWorkspaceConfigReadable,
  WorkspaceConfigParseError,
} from "./lib/mcp-config.mjs";
```

Replace the old single import from `./lib/mcp-config.mjs` with the expanded import above.

Add this helper near `emptyCfg()`:

```js
function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Add these tests after the existing `emptyCfg()` helper:

```js
describe("loadWorkspaceConfig parse status", () => {
  it("distinguishes missing config from malformed config", () => withTempWorkspace((dir) => {
    const cfg = loadWorkspaceConfig(dir);

    assert.equal(cfg.publicExisted, false);
    assert.equal(cfg.secretsExisted, false);
    assert.equal(cfg.publicStatus.exists, false);
    assert.equal(cfg.publicStatus.ok, true);
    assert.equal(cfg.secretStatus.exists, false);
    assert.equal(cfg.secretStatus.ok, true);
    assert.equal(cfg.hasParseErrors, false);
    assert.doesNotThrow(() => assertWorkspaceConfigReadable(cfg));
  }));

  it("reports malformed public config and blocks mutation", () => withTempWorkspace((dir) => {
    writeFileSync(join(dir, ".mcp.json"), "{ invalid json", "utf-8");
    const cfg = loadWorkspaceConfig(dir);

    assert.equal(cfg.publicExisted, true);
    assert.equal(cfg.publicStatus.exists, true);
    assert.equal(cfg.publicStatus.ok, false);
    assert.equal(cfg.publicStatus.error.code, "json-parse-failed");
    assert.equal(cfg.hasParseErrors, true);
    assert.throws(
      () => assertWorkspaceConfigReadable(cfg),
      (err) => err instanceof WorkspaceConfigParseError && err.code === "workspace-config-parse-failed",
    );
  }));

  it("reports malformed secret config separately", () => withTempWorkspace((dir) => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ bridges: {} }), "utf-8");
    writeFileSync(join(dir, ".mcp.local.json"), "{ invalid json", "utf-8");
    const cfg = loadWorkspaceConfig(dir);

    assert.equal(cfg.publicStatus.ok, true);
    assert.equal(cfg.secretStatus.exists, true);
    assert.equal(cfg.secretStatus.ok, false);
    assert.equal(cfg.parseErrors.length, 1);
    assert.match(cfg.parseErrors[0].path, /\.mcp\.local\.json$/);
  }));
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test mcp-config.test.mjs
```

Expected: failure because `loadWorkspaceConfig`, `assertWorkspaceConfigReadable`, and `WorkspaceConfigParseError` do not yet expose parse status.

- [ ] **Step 3: Implement parse-status loading**

In `lib/mcp-config.mjs`, replace `readJsonSafe()` with this implementation while keeping the exported name for compatibility:

```js
export class WorkspaceConfigParseError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "WorkspaceConfigParseError";
    this.code = "workspace-config-parse-failed";
    this.errors = errors;
  }
}

export function readJsonWithStatus(path, label = path) {
  if (!existsSync(path)) {
    return { path, label, exists: false, ok: true, data: null, error: null };
  }
  try {
    return { path, label, exists: true, ok: true, data: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (e) {
    return {
      path,
      label,
      exists: true,
      ok: false,
      data: null,
      error: {
        code: "json-parse-failed",
        message: e.message,
      },
    };
  }
}

/** Read JSON safely; return null on missing/parse error. Prefer readJsonWithStatus for new code. */
export function readJsonSafe(path) {
  const status = readJsonWithStatus(path);
  if (!status.ok) console.error(`Could not parse ${path}: ${status.error.message}`);
  return status.data;
}
```

Update `loadWorkspaceConfig()`:

```js
export function loadWorkspaceConfig(workspaceDir) {
  const publicPath = safeJoin(workspaceDir, PUBLIC_FILE);
  const secretPath = safeJoin(workspaceDir, SECRET_FILE);
  const publicStatus = readJsonWithStatus(publicPath, PUBLIC_FILE);
  const secretStatus = readJsonWithStatus(secretPath, SECRET_FILE);
  const parseErrors = [publicStatus, secretStatus]
    .filter((s) => !s.ok)
    .map((s) => ({ file: s.label, path: s.path, ...s.error }));

  return {
    publicPath,
    secretPath,
    public: publicStatus.data || {},
    secrets: secretStatus.data || {},
    publicExisted: publicStatus.exists,
    secretsExisted: secretStatus.exists,
    publicStatus,
    secretStatus,
    parseErrors,
    hasParseErrors: parseErrors.length > 0,
  };
}
```

Add this helper after `loadWorkspaceConfig()`:

```js
export function assertWorkspaceConfigReadable(cfg) {
  if (!cfg?.hasParseErrors) return;
  const details = cfg.parseErrors
    .map((e) => `${e.file}: ${e.message}`)
    .join("; ");
  throw new WorkspaceConfigParseError(`Workspace MCP config has parse errors: ${details}`, cfg.parseErrors);
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test mcp-config.test.mjs
```

Expected: all tests in `mcp-config.test.mjs` pass.

## Task 2: Install Result Primitives

**Files:**
- Create: `Installers/MCP-Suite/Scripts/lib/install-results.mjs`
- Create: `Installers/MCP-Suite/Scripts/install-results.test.mjs`

- [ ] **Step 1: Write failing tests for result rollup and redaction**

Create `install-results.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBridgeResult,
  setStage,
  finalizeBridgeResult,
  summarizeResults,
  exitCodeForResults,
  validateRequestedBridges,
  redactBridgeResult,
} from "./lib/install-results.mjs";

describe("install result rollup", () => {
  it("returns exit 0 when selected bridges are ok", () => {
    const r = finalizeBridgeResult(createBridgeResult("perforce", { requested: true }), "ok");
    const summary = summarizeResults([r]);
    assert.deepEqual(summary.byStatus, { ok: 1 });
    assert.equal(exitCodeForResults([r]), 0);
  });

  it("returns exit 1 when any selected bridge is partial", () => {
    const r = finalizeBridgeResult(createBridgeResult("uemcp", { requested: true }), "partial", {
      action: "Run sync-plugin.bat manually.",
    });
    assert.equal(exitCodeForResults([r]), 1);
    assert.deepEqual(r.actions, ["Run sync-plugin.bat manually."]);
  });

  it("returns exit 1 when any selected bridge fails", () => {
    const r = finalizeBridgeResult(createBridgeResult("miro", { requested: true }), "failed");
    assert.equal(exitCodeForResults([r]), 1);
  });

  it("returns exit 2 for unknown requested bridges", () => {
    const result = validateRequestedBridges(["perforce", "bogus"], { bridges: { perforce: {} } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknown, ["bogus"]);
    assert.equal(result.exitCode, 2);
  });

  it("redacts secret values from stages", () => {
    const r = createBridgeResult("atlassian", { requested: true });
    setStage(r, "credentials", {
      status: "ok",
      publicFields: [{ name: "ATLASSIAN_SITE_NAME", value: "example" }],
      secretFields: [{ name: "ATLASSIAN_API_TOKEN", value: "secret-token", present: true }],
    });
    const redacted = redactBridgeResult(r);
    assert.equal(redacted.stages.credentials.publicFields[0].value, "example");
    assert.equal(redacted.stages.credentials.secretFields[0].present, true);
    assert.ok(!("value" in redacted.stages.credentials.secretFields[0]));
    assert.equal(JSON.stringify(redacted).includes("secret-token"), false);
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test install-results.test.mjs
```

Expected: module-not-found failure for `lib/install-results.mjs`.

- [ ] **Step 3: Implement `install-results.mjs`**

Create `lib/install-results.mjs`:

```js
export const RESULT_STATUS = Object.freeze({
  OK: "ok",
  PARTIAL: "partial",
  FAILED: "failed",
  SKIPPED: "skipped",
  DISABLED: "disabled",
  ABSENT: "absent",
});

const STATUS_SEVERITY = Object.freeze({
  ok: "info",
  skipped: "info",
  disabled: "info",
  absent: "info",
  partial: "warning",
  failed: "error",
});

export function createBridgeResult(bridge, opts = {}) {
  return {
    bridge,
    requested: opts.requested === true,
    previouslyEnabled: opts.previouslyEnabled === true,
    status: "skipped",
    severity: "info",
    stages: {},
    actions: [],
  };
}

export function setStage(result, stageName, stageResult) {
  result.stages[stageName] = { ...stageResult };
  return result;
}

export function addAction(result, action) {
  if (action && !result.actions.includes(action)) result.actions.push(action);
  return result;
}

export function finalizeBridgeResult(result, status, opts = {}) {
  result.status = status;
  result.severity = STATUS_SEVERITY[status] || "error";
  if (opts.action) addAction(result, opts.action);
  if (Array.isArray(opts.actions)) {
    for (const action of opts.actions) addAction(result, action);
  }
  return result;
}

export function summarizeResults(results) {
  const byStatus = {};
  const bySeverity = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
  }
  return { total: results.length, byStatus, bySeverity };
}

export function exitCodeForResults(results, opts = {}) {
  if (opts.usageError) return 2;
  if (results.some((r) => r.requested && (r.status === "failed" || r.status === "partial"))) return 1;
  return 0;
}

export function validateRequestedBridges(requested, rootManifest) {
  const known = new Set(Object.keys(rootManifest.bridges || {}));
  const unknown = requested.filter((name) => !known.has(name));
  return unknown.length === 0
    ? { ok: true, unknown: [], exitCode: 0 }
    : { ok: false, unknown, exitCode: 2 };
}

export function redactBridgeResult(result) {
  return redactValue(result);
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "secretFields" && Array.isArray(child)) {
      out[key] = child.map((field) => ({ name: field.name, present: field.present === true }));
    } else if (key.toLowerCase().includes("password") || key.toLowerCase().includes("token")) {
      out[key] = child ? "[REDACTED]" : child;
    } else {
      out[key] = redactValue(child);
    }
  }
  return out;
}

export function formatInstallSummary(results, exitCode) {
  const summary = summarizeResults(results);
  const lines = ["", "Install summary:"];
  for (const [status, count] of Object.entries(summary.byStatus)) {
    lines.push(`  ${status}: ${count}`);
  }
  for (const r of results) {
    if (r.status === "ok") continue;
    lines.push(`  ${r.bridge}: ${r.status}`);
    for (const action of r.actions) lines.push(`    next: ${action}`);
  }
  lines.push(`  exitCode: ${exitCode}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test install-results.test.mjs
```

Expected: all tests in `install-results.test.mjs` pass.

## Task 3: Generic Doctor Module

**Files:**
- Create: `Installers/MCP-Suite/Scripts/lib/doctor.mjs`
- Create: `Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs` as a temporary stub
- Create: `Installers/MCP-Suite/Scripts/doctor.test.mjs`

- [ ] **Step 1: Write failing tests for generic doctor checks**

Create `doctor.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkspaceDoctor, formatDoctorReport } from "./lib/doctor.mjs";

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-doctor-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifest() {
  return {
    bridges: {
      sample: { displayName: "Sample", source: { type: "co-located", path: "bridges/sample" } },
    },
  };
}

function writeServerBundle(root, version = "1.0.0") {
  const bridgeDir = join(root, "bundle");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "server.mjs"), "console.log('sample');\n", "utf-8");
  writeFileSync(join(bridgeDir, "manifest.json"), JSON.stringify({
    name: "sample",
    version,
    main: "server.mjs",
    fields: [
      { name: "SAMPLE_PUBLIC", required: true, secret: false },
      { name: "SAMPLE_SECRET", required: true, secret: true },
    ],
  }, null, 2), "utf-8");
  return bridgeDir;
}

describe("runWorkspaceDoctor generic checks", () => {
  it("reports missing public config as non-ok", () => withTempWorkspace((dir) => {
    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: manifest() });
    assert.equal(report.exitCode, 1);
    assert.equal(report.config.public.exists, false);
    assert.equal(report.issues.some((i) => i.code === "public-config-missing"), true);
  }));

  it("reports malformed public config as fatal", () => withTempWorkspace((dir) => {
    writeFileSync(join(dir, ".mcp.json"), "{ invalid json", "utf-8");
    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: manifest() });
    assert.equal(report.exitCode, 2);
    assert.equal(report.issues.some((i) => i.code === "config-parse-failed"), true);
  }));

  it("reports missing server path for enabled bridge", () => withTempWorkspace((dir) => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        sample: {
          command: "node",
          args: [join(dir, "missing", "server.mjs")],
          env: { SAMPLE_PUBLIC: "present", PROJECT_ROOT: dir },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "present" },
      },
    }, null, 2), "utf-8");

    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: manifest() });
    const bridge = report.bridges.find((b) => b.name === "sample");
    assert.equal(report.exitCode, 1);
    assert.equal(bridge.status, "enabled");
    assert.equal(bridge.issues.some((i) => i.code === "server-path-missing"), true);
  }));

  it("reports missing secret when the bridge manifest requires one", () => withTempWorkspace((dir) => {
    const bridgeDir = writeServerBundle(dir, "1.0.0");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bridgeDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "present", PROJECT_ROOT: dir },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "present" },
      },
    }, null, 2), "utf-8");

    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: manifest() });
    const bridge = report.bridges.find((b) => b.name === "sample");
    assert.equal(report.exitCode, 1);
    assert.equal(bridge.issues.some((i) => i.code === "missing-secret"), true);
  }));

  it("reports version mismatch from located bridge manifest", () => withTempWorkspace((dir) => {
    const bridgeDir = writeServerBundle(dir, "2.0.0");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bridgeDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "present", PROJECT_ROOT: dir },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "present" },
      },
    }, null, 2), "utf-8");
    writeFileSync(join(dir, ".mcp.local.json"), JSON.stringify({
      bridges: { sample: { SAMPLE_SECRET: "present" } },
    }), "utf-8");

    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: manifest() });
    const bridge = report.bridges.find((b) => b.name === "sample");
    assert.equal(bridge.issues.some((i) => i.code === "version-mismatch"), true);
    assert.match(formatDoctorReport(report), /version-mismatch/);
  }));
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test doctor.test.mjs
```

Expected: module-not-found failure for `lib/doctor.mjs`.

- [ ] **Step 3: Implement `doctor.mjs`**

Create a temporary `lib/uemcp-doctor.mjs` stub so the generic doctor tests can run before the UEMCP-specific task:

```js
export function evaluateUemcpHealth() {
  return { facts: {}, issues: [] };
}
```

Create `lib/doctor.mjs` with these exported functions:

```js
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { loadWorkspaceConfig, PUBLIC_FILE, SECRET_FILE } from "./mcp-config.mjs";
import { evaluateUemcpHealth } from "./uemcp-doctor.mjs";

export function runWorkspaceDoctor({ workspaceDir, rootManifest }) {
  const cfg = loadWorkspaceConfig(workspaceDir);
  const report = {
    workspace: workspaceDir,
    exitCode: 0,
    config: {
      public: { path: cfg.publicPath, exists: cfg.publicStatus.exists, ok: cfg.publicStatus.ok },
      secret: { path: cfg.secretPath, exists: cfg.secretStatus.exists, ok: cfg.secretStatus.ok },
      layout: cfg.public.bridges ? "modern" : "legacy",
    },
    issues: [],
    bridges: [],
  };

  if (!cfg.publicStatus.exists) {
    addIssue(report, "public-config-missing", "error", `${PUBLIC_FILE} is missing.`, "Run the installer for this workspace.");
    report.exitCode = 1;
    return report;
  }

  if (cfg.hasParseErrors) {
    for (const e of cfg.parseErrors) {
      addIssue(report, "config-parse-failed", "error", `${e.file} could not be parsed: ${e.message}`, "Fix the JSON before running install or update.");
    }
    report.exitCode = 2;
    return report;
  }

  for (const [name, entry] of Object.entries(rootManifest.bridges || {})) {
    const bridge = evaluateBridgeHealth(name, entry, cfg);
    if (name === "uemcp" && bridge.status === "enabled") {
      const uemcp = evaluateUemcpHealth({ cfg, bridge });
      bridge.facts = { ...bridge.facts, ...uemcp.facts };
      bridge.issues.push(...uemcp.issues);
    }
    report.bridges.push(bridge);
  }

  const hasErrors = report.bridges.some((b) => b.issues.some((i) => i.severity === "error"));
  const hasWarnings = report.bridges.some((b) => b.issues.some((i) => i.severity === "warning"));
  report.exitCode = hasErrors || hasWarnings || report.issues.length > 0 ? 1 : 0;
  return report;
}

export function evaluateBridgeHealth(name, entry, cfg) {
  const declared = cfg.public.bridges?.[name];
  const legacy = cfg.public.mcpServers?.[name];
  const enabled = declared?.enabled !== false && (declared || legacy);
  const status = !declared && !legacy ? "absent" : enabled ? "enabled" : "disabled";
  const bridge = { name, displayName: entry.displayName || name, status, issues: [], facts: {} };

  if (status !== "enabled") return bridge;

  const launch = cfg.public.mcpServers?.[name];
  if (!launch) {
    addBridgeIssue(bridge, "launch-entry-missing", "error", "Enabled bridge has no mcpServers launch entry.", "Re-run installer for this bridge.");
    return bridge;
  }

  bridge.facts.command = launch.command || null;
  bridge.facts.serverPath = Array.isArray(launch.args) ? launch.args[0] : null;
  if (!bridge.facts.serverPath) {
    addBridgeIssue(bridge, "server-arg-missing", "error", "Launch entry has no server path argument.", "Re-run installer for this bridge.");
    return bridge;
  }
  if (launch.command === "node" && !existsSync(bridge.facts.serverPath)) {
    addBridgeIssue(bridge, "server-path-missing", "error", `Server path does not exist: ${bridge.facts.serverPath}`, "Run update or reinstall this bridge.");
    return bridge;
  }

  const manifest = readBridgeManifestNearServer(bridge.facts.serverPath);
  if (manifest) {
    bridge.facts.manifestVersion = manifest.version || null;
    bridge.facts.manifestPath = manifest.path;
    const recorded = declared?.version || null;
    bridge.facts.recordedVersion = recorded;
    if (recorded && manifest.version && recorded !== manifest.version) {
      addBridgeIssue(bridge, "version-mismatch", "warning", `Recorded version ${recorded} differs from server bundle version ${manifest.version}.`, "Run update for this bridge.");
    }
    checkRequiredFields(bridge, name, manifest, cfg, launch.env || {}, declared || {});
  }

  return bridge;
}

function checkRequiredFields(bridge, name, manifest, cfg, env, declared) {
  for (const field of manifest.fields || []) {
    if (!field.required) continue;
    if (field.secret) {
      const present = cfg.secrets.bridges?.[name]?.[field.name] || cfg.secrets.mcpServers?.[name]?.env?.[field.name];
      if (!present) addBridgeIssue(bridge, "missing-secret", "error", `Required secret ${field.name} is missing.`, `Re-run installer and provide ${field.name}.`);
    } else {
      const present = env[field.name] || declared[field.name];
      if (!present) addBridgeIssue(bridge, "missing-public-field", "error", `Required public field ${field.name} is missing.`, `Re-run installer and provide ${field.name}.`);
    }
  }
}

function readBridgeManifestNearServer(serverPath) {
  const candidates = [
    join(dirname(serverPath), "manifest.json"),
    join(dirname(dirname(serverPath)), "manifest.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return { path, ...JSON.parse(readFileSync(path, "utf-8")) };
    } catch {
      return null;
    }
  }
  return null;
}

function addIssue(report, code, severity, message, action) {
  report.issues.push({ code, severity, message, action });
}

function addBridgeIssue(bridge, code, severity, message, action) {
  bridge.issues.push({ code, severity, message, action });
}

export function formatDoctorReport(report) {
  const lines = [`Doctor report - workspace: ${report.workspace}`, ""];
  lines.push(`  ${PUBLIC_FILE}: ${report.config.public.exists ? "present" : "missing"}`);
  lines.push(`  ${SECRET_FILE}: ${report.config.secret.exists ? "present" : "missing"}`);
  lines.push(`  Layout: ${report.config.layout}`, "");

  for (const issue of report.issues) {
    lines.push(`  [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}`);
    if (issue.action) lines.push(`    next: ${issue.action}`);
  }

  for (const bridge of report.bridges) {
    const verdict = bridge.issues.length === 0 ? "ok" : bridge.issues.some((i) => i.severity === "error") ? "error" : "warning";
    lines.push(`  ${bridge.name.padEnd(12)} ${bridge.status.padEnd(10)} ${verdict}`);
    for (const issue of bridge.issues) {
      lines.push(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
      if (issue.action) lines.push(`      next: ${issue.action}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test doctor.test.mjs
```

Expected: all tests in `doctor.test.mjs` pass.

## Task 4: UEMCP Doctor Checks

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs`
- Create: `Installers/MCP-Suite/Scripts/uemcp-doctor.test.mjs`

- [ ] **Step 1: Write failing UEMCP tests**

Create `uemcp-doctor.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkspaceDoctor } from "./lib/doctor.mjs";

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "uemcp-doctor-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rootManifest() {
  return {
    bridges: {
      uemcp: {
        displayName: "Unreal Engine MCP (UEMCP)",
        source: { type: "remote-repo", repo: "noahbutcher97/UEMCP" },
      },
    },
  };
}

function writeUemcpFixture(workspace, opts = {}) {
  const cache = join(workspace, "cache", "uemcp");
  const projectRoot = join(workspace, "Game");
  const pluginRoot = join(projectRoot, "Plugins", "UEMCP");
  mkdirSync(join(cache, "server"), { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });

  const serverVersion = opts.serverVersion || "1.0.4";
  const pluginVersion = opts.pluginVersion || "1.0.13";
  writeFileSync(join(cache, "server", "server.mjs"), "console.log('uemcp');\n", "utf-8");
  writeFileSync(join(cache, "manifest.json"), JSON.stringify({
    name: "uemcp",
    version: serverVersion,
    main: "server/server.mjs",
    fields: [
      { name: "UNREAL_PROJECT_ROOT", required: true, secret: false },
      { name: "UNREAL_PROJECT_NAME", required: true, secret: false },
      { name: "UNREAL_TCP_TIMEOUT_MS", required: false, secret: false, default: "10000" },
    ],
  }, null, 2), "utf-8");

  writeFileSync(join(projectRoot, "Game.uproject"), JSON.stringify({
    FileVersion: 3,
    Plugins: opts.includeProjectDeps ? [
      { Name: "RemoteControl", Enabled: true },
      { Name: "PythonScriptPlugin", Enabled: true },
      { Name: "GeometryScripting", Enabled: true },
    ] : [],
  }, null, 2), "utf-8");

  writeFileSync(join(pluginRoot, "UEMCP.uplugin"), JSON.stringify({
    FileVersion: 3,
    Version: 14,
    VersionName: pluginVersion,
  }, null, 2), "utf-8");

  if (opts.marker !== false) {
    writeFileSync(join(pluginRoot, ".uemcp-deploy-marker.json"), JSON.stringify({
      schemaVersion: "1.0",
      manifestVersion: pluginVersion,
      upluginVersionName: pluginVersion,
    }, null, 2), "utf-8");
  }

  if (opts.dll !== false) {
    mkdirSync(join(pluginRoot, "Binaries", "Win64"), { recursive: true });
    writeFileSync(join(pluginRoot, "Binaries", "Win64", "UnrealEditor-UEMCP.dll"), "fake", "utf-8");
  }

  writeFileSync(join(workspace, ".mcp.json"), JSON.stringify({
    mcpServers: {
      uemcp: {
        command: "node",
        args: [join(cache, "server", "server.mjs")],
        env: {
          PROJECT_ROOT: workspace,
          UNREAL_PROJECT_ROOT: projectRoot,
          UNREAL_PROJECT_NAME: "Game",
          UNREAL_TCP_TIMEOUT_MS: opts.timeout || "5000",
        },
      },
    },
    bridges: {
      uemcp: {
        enabled: true,
        version: serverVersion,
        UNREAL_PROJECT_ROOT: projectRoot,
        UNREAL_PROJECT_NAME: "Game",
        UNREAL_TCP_TIMEOUT_MS: opts.timeout || "5000",
      },
    },
  }, null, 2), "utf-8");
}

describe("UEMCP doctor checks", () => {
  it("reports server/deployed plugin mismatch, timeout drift, and missing project deps", () => withTempWorkspace((dir) => {
    writeUemcpFixture(dir);
    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: rootManifest() });
    const bridge = report.bridges.find((b) => b.name === "uemcp");
    const codes = bridge.issues.map((i) => i.code);
    assert.equal(report.exitCode, 1);
    assert.ok(codes.includes("uemcp-version-mismatch"));
    assert.ok(codes.includes("uemcp-timeout-drift"));
    assert.ok(codes.includes("uemcp-needs-project-deps"));
  }));

  it("reports missing deploy marker and missing DLL", () => withTempWorkspace((dir) => {
    writeUemcpFixture(dir, { marker: false, dll: false, includeProjectDeps: true, timeout: "10000" });
    const report = runWorkspaceDoctor({ workspaceDir: dir, rootManifest: rootManifest() });
    const bridge = report.bridges.find((b) => b.name === "uemcp");
    const codes = bridge.issues.map((i) => i.code);
    assert.ok(codes.includes("uemcp-needs-sync"));
    assert.ok(codes.includes("uemcp-needs-build"));
  }));
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test uemcp-doctor.test.mjs
```

Expected: module-not-found or missing UEMCP issue failures.

- [ ] **Step 3: Implement `uemcp-doctor.mjs`**

Replace the temporary `lib/uemcp-doctor.mjs` stub with:

```js
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REQUIRED_PROJECT_PLUGINS = ["RemoteControl", "PythonScriptPlugin", "GeometryScripting"];

export function evaluateUemcpHealth({ cfg, bridge }) {
  const facts = {};
  const issues = [];
  const env = cfg.public.mcpServers?.uemcp?.env || {};
  const declared = cfg.public.bridges?.uemcp || {};
  const projectRoot = env.UNREAL_PROJECT_ROOT || declared.UNREAL_PROJECT_ROOT;
  const projectName = env.UNREAL_PROJECT_NAME || declared.UNREAL_PROJECT_NAME;
  facts.projectRoot = projectRoot || null;
  facts.projectName = projectName || null;

  if (!projectRoot || !projectName) {
    issue(issues, "uemcp-project-missing", "error", "UEMCP project root/name is missing.", "Re-run installer with UNREAL_PROJECT_ROOT and UNREAL_PROJECT_NAME.");
    return { facts, issues };
  }

  const uprojectPath = join(projectRoot, `${projectName}.uproject`);
  const pluginRoot = join(projectRoot, "Plugins", "UEMCP");
  const pluginDescriptorPath = join(pluginRoot, "UEMCP.uplugin");
  const markerPath = join(pluginRoot, ".uemcp-deploy-marker.json");
  const dllPath = join(pluginRoot, "Binaries", "Win64", "UnrealEditor-UEMCP.dll");
  facts.uprojectPath = uprojectPath;
  facts.pluginDescriptorPath = pluginDescriptorPath;
  facts.deployMarkerPath = markerPath;
  facts.dllPath = dllPath;

  const uproject = readJsonIfExists(uprojectPath);
  if (!uproject.exists) {
    issue(issues, "uemcp-uproject-missing", "error", `Uproject not found: ${uprojectPath}`, "Choose the correct Unreal project and re-run installer.");
  } else if (!uproject.ok) {
    issue(issues, "uemcp-uproject-parse-failed", "error", `Uproject JSON parse failed: ${uproject.error}`, "Fix the .uproject JSON before running UEMCP setup.");
  } else {
    const enabled = new Set((uproject.data.Plugins || []).filter((p) => p.Enabled === true).map((p) => p.Name));
    const missing = REQUIRED_PROJECT_PLUGINS.filter((name) => !enabled.has(name));
    if (missing.length > 0) {
      issue(issues, "uemcp-needs-project-deps", "warning", `Target .uproject is missing required plugins: ${missing.join(", ")}.`, "Run UEMCP standalone setup or enable required plugins, then rebuild/restart Unreal.");
    }
  }

  const plugin = readJsonIfExists(pluginDescriptorPath);
  const marker = readJsonIfExists(markerPath);
  if (!plugin.exists) {
    issue(issues, "uemcp-plugin-missing", "error", "UEMCP plugin descriptor is missing from the target project.", "Run UEMCP sync/setup for this project.");
  } else if (plugin.ok) {
    facts.pluginVersion = plugin.data.VersionName || String(plugin.data.Version || "");
  }

  if (!marker.exists) {
    issue(issues, "uemcp-needs-sync", "warning", "UEMCP deploy marker is missing.", "Run sync-plugin.bat once to seed the deploy marker.");
  } else if (marker.ok) {
    facts.deployMarkerVersion = marker.data.manifestVersion || marker.data.upluginVersionName || null;
  }

  const configuredServerVersion = bridge.facts?.manifestVersion || declared.version || null;
  facts.configuredServerVersion = configuredServerVersion;
  const deployedVersion = facts.deployMarkerVersion || facts.pluginVersion || null;
  if (configuredServerVersion && deployedVersion && configuredServerVersion !== deployedVersion) {
    issue(issues, "uemcp-version-mismatch", "warning", `Configured server bundle is ${configuredServerVersion}, but deployed UEMCP plugin is ${deployedVersion}.`, "Run installer update after remote cache identity is fixed, or re-run UEMCP setup with matching server/plugin versions.");
  }

  const configuredTimeout = env.UNREAL_TCP_TIMEOUT_MS || declared.UNREAL_TCP_TIMEOUT_MS;
  const defaultTimeout = bridge.facts?.manifestPath ? readManifestDefault(bridge.facts.manifestPath, "UNREAL_TCP_TIMEOUT_MS") : null;
  facts.configuredTimeout = configuredTimeout || null;
  facts.defaultTimeout = defaultTimeout || null;
  if (configuredTimeout && defaultTimeout && configuredTimeout !== defaultTimeout) {
    issue(issues, "uemcp-timeout-drift", "warning", `UNREAL_TCP_TIMEOUT_MS is ${configuredTimeout}, bundle default is ${defaultTimeout}.`, "Update workspace config if this is not an intentional override.");
  }

  if (!existsSync(dllPath)) {
    issue(issues, "uemcp-needs-build", "warning", "UEMCP editor DLL is missing.", "Build the Unreal project after syncing the plugin.");
  }

  return { facts, issues };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return { exists: false, ok: true, data: null, error: null };
  try {
    return { exists: true, ok: true, data: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (e) {
    return { exists: true, ok: false, data: null, error: e.message };
  }
}

function readManifestDefault(manifestPath, fieldName) {
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest.ok || !manifest.data) return null;
  return (manifest.data.fields || []).find((f) => f.name === fieldName)?.default || null;
}

function issue(issues, code, severity, message, action) {
  issues.push({ code, severity, message, action });
}
```

- [ ] **Step 4: Run UEMCP and generic doctor tests**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test doctor.test.mjs uemcp-doctor.test.mjs
```

Expected: both test files pass.

## Task 5: Receipt Module

**Files:**
- Create: `Installers/MCP-Suite/Scripts/lib/receipt.mjs`
- Create: `Installers/MCP-Suite/Scripts/receipt.test.mjs`

- [ ] **Step 1: Write failing receipt tests**

Create `receipt.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        status: "failed",
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
    assert.equal(receipt.bridgeResults[0].stages.credentials.secretFields[0].present, true);
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
    const data = JSON.parse(readFileSync(written.path, "utf-8"));
    assert.equal(data.mode, "install");
  }));
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test receipt.test.mjs
```

Expected: module-not-found failure for `lib/receipt.mjs`.

- [ ] **Step 3: Implement receipt serialization and writing**

Create `lib/receipt.mjs`:

```js
import { mkdirSync, writeFileSync } from "fs";
import { safeJoin } from "./safepath.mjs";
import { redactBridgeResult, summarizeResults } from "./install-results.mjs";

export function serializeReceipt(input) {
  const startedAt = input.startedAt || new Date().toISOString();
  const endedAt = input.endedAt || new Date().toISOString();
  const bridgeResults = (input.bridgeResults || []).map(redactBridgeResult);
  return {
    schemaVersion: "1.0",
    runId: input.runId || makeRunId(startedAt),
    mode: input.mode,
    startedAt,
    endedAt,
    aiToolsRoot: input.aiToolsRoot,
    workspace: input.workspace,
    selectedBridges: input.selectedBridges || [],
    exitCode: input.exitCode,
    summary: summarizeResults(bridgeResults),
    files: input.files || {},
    bridgeResults,
    doctorSummary: input.doctorSummary || null,
    nextSteps: input.nextSteps || [],
  };
}

export function writeInstallReceipt(workspaceDir, input) {
  const receipt = serializeReceipt(input);
  const dir = safeJoin(workspaceDir, ".mcp-install-receipts");
  mkdirSync(dir, { recursive: true });
  const path = safeJoin(dir, `${receipt.runId}-${receipt.mode}.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", "utf-8");
  return { path, receipt };
}

function makeRunId(iso) {
  return iso.replace(/[:.]/g, "-").slice(0, 19);
}
```

- [ ] **Step 4: Run receipt tests**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test receipt.test.mjs
```

Expected: all tests in `receipt.test.mjs` pass.

## Task 6: Wire Doctor CLI

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`

- [ ] **Step 1: Import doctor helpers**

Add imports near the existing installer helper imports:

```js
import { runWorkspaceDoctor, formatDoctorReport } from "./lib/doctor.mjs";
```

- [ ] **Step 2: Replace inline `runDoctor()`**

Replace the body of `runDoctor(workspaceDir, rootManifest)` with:

```js
function runDoctor(workspaceDir, rootManifest) {
  const report = runWorkspaceDoctor({ workspaceDir, rootManifest });
  console.log(`\n${formatDoctorReport(report)}`);
  return report.exitCode;
}
```

Keep the function name so the direct-invocation block at the bottom needs minimal change.

- [ ] **Step 3: Run doctor tests and live read-only doctor**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test doctor.test.mjs uemcp-doctor.test.mjs

cd D:\DevTools\AI-Tools
node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\UnrealProjects\5.6\OperationPhoenix
```

Expected:

- test files pass
- OperationPhoenix doctor exits `1`
- output includes `uemcp-version-mismatch`
- output includes `uemcp-timeout-drift`
- output includes `uemcp-needs-project-deps`

## Task 7: Wire Install Result Accounting

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`

- [ ] **Step 1: Import result and receipt helpers**

Add imports near other local helpers:

```js
import {
  createBridgeResult,
  setStage,
  finalizeBridgeResult,
  exitCodeForResults,
  validateRequestedBridges,
  formatInstallSummary,
} from "./lib/install-results.mjs";
import { writeInstallReceipt } from "./lib/receipt.mjs";
import { assertWorkspaceConfigReadable } from "./lib/mcp-config.mjs";
```

If `assertWorkspaceConfigReadable` is already imported through the existing mcp-config import block, add it there instead of duplicating imports.

- [ ] **Step 2: Make unknown `--bridges=` a usage error**

In `runInstall()`, replace:

```js
chosen = args.bridges.filter((n) => rootManifest.bridges[n]);
const bad = args.bridges.filter((n) => !rootManifest.bridges[n]);
if (bad.length > 0) console.log(`Skipping unknown: ${bad.join(", ")}`);
```

with:

```js
const requested = validateRequestedBridges(args.bridges, rootManifest);
if (!requested.ok) {
  console.error(`Unknown bridge name(s): ${requested.unknown.join(", ")}`);
  console.error(`Available bridges: ${Object.keys(rootManifest.bridges).join(", ")}`);
  return requested.exitCode;
}
chosen = args.bridges;
```

- [ ] **Step 3: Block malformed config before mutation**

Immediately after:

```js
const cfg = loadWorkspaceConfig(workspaceDir);
```

add:

```js
try {
  assertWorkspaceConfigReadable(cfg);
} catch (e) {
  printErr(e.message);
  for (const err of e.errors || []) {
    printErr(`  ${err.path}: ${err.message}`);
  }
  return 2;
}
```

- [ ] **Step 4: Collect bridge results in the selected bridge loop**

After `chosen` is known and before the loop that can disable previously enabled bridges, add:

```js
const bridgeResults = [];
let configTouched = false;
```

Inside the disable confirmation branch, replace:

```js
if (disable) disableBridgeInConfig(cfg, name);
```

with:

```js
if (disable) {
  disableBridgeInConfig(cfg, name);
  configTouched = true;
  bridgeResults.push(finalizeBridgeResult(
    createBridgeResult(name, { requested: false, previouslyEnabled: true }),
    "disabled",
  ));
}
```

Inside `for (const name of chosen)`, create a result at the top:

```js
const result = createBridgeResult(name, {
  requested: true,
  previouslyEnabled: previouslyEnabled.has(name),
});
bridgeResults.push(result);
```

For each existing `continue` path, set a stage and finalize the result before continuing. Use this mapping:

- fetch failure: `source` stage failed, top-level `failed`
- own setup failure: `setup` stage failed, top-level `failed`
- missing remote manifest with preserved existing config: `manifest` stage skipped, top-level `partial`
- missing remote manifest with no existing config: `manifest` stage failed, top-level `failed`
- `gatherCredentials` abort: `credentials` stage failed, top-level `failed`
- non-interactive validation failure: `validation` stage failed, top-level `failed`
- interactive user declines retry and declines save anyway: `validation` stage failed, top-level `skipped`
- interactive user chooses save anyway after validation failure: `validation` stage failed and `config` stage ok, top-level `partial`
- post-setup failure: `postSetup` stage failed, top-level `partial`
- normal success: all reached stages ok, top-level `ok`

Concrete examples:

```js
try {
  bridgeDir = await ensureBridgeAvailable(entry, name, { forceRefresh: args.update });
  setStage(result, "source", { status: "ok", path: bridgeDir });
} catch (e) {
  setStage(result, "source", { status: "failed", message: e.message });
  finalizeBridgeResult(result, "failed", { action: `Check network/cache state and re-run installer for ${name}.` });
  printErr(`Could not fetch bridge: ${e.message}`);
  continue;
}
```

After `setBridgeInConfig(...)`, add:

```js
configTouched = true;
setStage(result, "config", { status: "ok", serverPath });
```

After successful post-setup:

```js
setStage(result, "postSetup", { status: "ok" });
```

After failed post-setup:

```js
setStage(result, "postSetup", { status: "failed", message: psResult.error || `exit ${psResult.status}` });
finalizeBridgeResult(result, "partial", { action: `Run any required ${name} post-setup steps manually, then run doctor.` });
```

At the end of each bridge iteration, only call `finalizeBridgeResult(result, "ok")` if `result.status` is still `"skipped"` and the bridge actually reached config or own-setup success.

- [ ] **Step 5: Write config only when something changed**

Replace the unconditional write block:

```js
writeWorkspaceConfig(cfg, { backupTag });

const ignoredFiles = ensureSecretIgnored(workspaceDir);
for (const f of ignoredFiles) {
  console.log(`  Added '${SECRET_FILE}' to ${f}`);
}
```

with:

```js
let ignoredFiles = [];
let receiptPath = null;
if (configTouched) {
  writeWorkspaceConfig(cfg, { backupTag });
  ignoredFiles = ensureSecretIgnored(workspaceDir);
  for (const f of ignoredFiles) {
    console.log(`  Added '${SECRET_FILE}' to ${f}`);
  }
}
```

- [ ] **Step 6: Write receipt and return result-derived exit code**

Replace:

```js
console.log(`\nDone. Run 'install.bat --doctor' to verify.\n`);
```

with:

```js
const exitCode = exitCodeForResults(bridgeResults);
if (configTouched || bridgeResults.length > 0) {
  const receipt = writeInstallReceipt(workspaceDir, {
    mode: args.update ? "update" : "install",
    workspace: workspaceDir,
    aiToolsRoot: resolve(MCP_SERVERS_ROOT, ".."),
    selectedBridges: chosen,
    exitCode,
    files: {
      publicConfig: cfg.publicPath,
      secretConfig: cfg.secretPath,
      ignoreFilesChanged: ignoredFiles,
    },
    bridgeResults,
    nextSteps: [`Run: node Installers\\MCP-Suite\\Scripts\\install.mjs --doctor --workspace=${workspaceDir}`],
  });
  receiptPath = receipt.path;
  printInfo(`Receipt written: ${receiptPath}`);
}

console.log(formatInstallSummary(bridgeResults, exitCode));
console.log(`\nRun this read-only doctor check next:`);
console.log(`  node Installers\\MCP-Suite\\Scripts\\install.mjs --doctor --workspace=${workspaceDir}\n`);
return exitCode;
```

Remove the old final `return 0;` at the end of `runInstall()` because the function now returns the result-derived `exitCode`. Keep the optional update-check hook before that final return:

```js
if (args.enableUpdateChecks) {
  enableSessionStartHook(workspaceDir, rootManifest);
}

return exitCode;
```

- [ ] **Step 7: Run installer unit tests**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test
```

Expected: all installer tests pass.

## Task 8: End-To-End Read-Only Doctor Proof

**Files:**
- No file changes unless previous tasks exposed a gap.

- [ ] **Step 1: Capture timestamps before doctor**

Run:

```powershell
$paths = @(
  'D:\UnrealProjects\5.6\OperationPhoenix\.mcp.json',
  'D:\UnrealProjects\5.6\OperationPhoenix\.mcp.local.json',
  'D:\UnrealProjects\5.6\OperationPhoenix\.codex\config.toml',
  'D:\UnrealProjects\5.6\OperationPhoenix\OnSight\OnSight.uproject'
)
$before = @{}
foreach ($p in $paths) { if (Test-Path $p) { $before[$p] = (Get-Item $p).LastWriteTimeUtc } }
$before.GetEnumerator() | Sort-Object Name | Format-Table -AutoSize
```

Expected: prints current timestamps.

- [ ] **Step 2: Run read-only doctor**

Run:

```powershell
node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\UnrealProjects\5.6\OperationPhoenix
$LASTEXITCODE
```

Expected:

- exit code is `1`
- output includes `uemcp-version-mismatch`
- output includes `uemcp-timeout-drift`
- output includes `uemcp-needs-project-deps`

- [ ] **Step 3: Confirm doctor did not mutate watched files**

Run:

```powershell
$after = @{}
foreach ($p in $paths) { if (Test-Path $p) { $after[$p] = (Get-Item $p).LastWriteTimeUtc } }
foreach ($p in $before.Keys) {
  [PSCustomObject]@{
    Path = $p
    Unchanged = ($before[$p] -eq $after[$p])
    Before = $before[$p]
    After = $after[$p]
  }
} | Format-Table -AutoSize
```

Expected: every `Unchanged` value is `True`.

## Task 9: Full Verification

**Files:**
- No file changes unless verification exposes a defect.

- [ ] **Step 1: Run installer test suite**

Run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test
```

Expected: all installer tests pass, including `mcp-config.test.mjs`, `install-results.test.mjs`, `doctor.test.mjs`, `uemcp-doctor.test.mjs`, and `receipt.test.mjs`.

- [ ] **Step 2: Syntax-check tracked installer and bridge JavaScript**

Run:

```powershell
cd D:\DevTools\AI-Tools
git ls-files "Installers/MCP-Suite/Scripts/**/*.mjs" "MCP-Servers/**/*.mjs" | % { node --check $_ }
```

Expected: no syntax errors.

- [ ] **Step 3: Run final diff hygiene**

Run:

```powershell
git diff --check -- Installers\MCP-Suite\Scripts
```

Expected: exit code `0`. A line-ending warning from Git is acceptable only if it already exists and is not introduced by this slice.

- [ ] **Step 4: Inspect changed files**

Run:

```powershell
git status --short
git diff -- Installers\MCP-Suite\Scripts
```

Expected:

- only expected installer files changed under `Installers/MCP-Suite/Scripts`
- unrelated dirty files remain untouched
- no secret values appear in diffs

## Commit Guidance

Do not commit automatically in the current dirty tree. If the user explicitly asks for commits, use exact staging:

```powershell
git add Installers\MCP-Suite\Scripts\lib\mcp-config.mjs `
        Installers\MCP-Suite\Scripts\mcp-config.test.mjs `
        Installers\MCP-Suite\Scripts\lib\install-results.mjs `
        Installers\MCP-Suite\Scripts\install-results.test.mjs `
        Installers\MCP-Suite\Scripts\lib\doctor.mjs `
        Installers\MCP-Suite\Scripts\doctor.test.mjs `
        Installers\MCP-Suite\Scripts\lib\uemcp-doctor.mjs `
        Installers\MCP-Suite\Scripts\uemcp-doctor.test.mjs `
        Installers\MCP-Suite\Scripts\lib\receipt.mjs `
        Installers\MCP-Suite\Scripts\receipt.test.mjs `
        Installers\MCP-Suite\Scripts\install.mjs
git commit -m "installer: add result accounting and expanded doctor"
```

Before committing, re-run Task 9.

## Completion Criteria

The implementation is complete only when:

- malformed workspace MCP JSON is distinguishable from missing config
- install/update selected-bridge failures affect the final exit code
- non-secret receipts are written for real install/update attempts that reach mutation/result accounting
- doctor is read-only and flags the live OperationPhoenix UEMCP mismatch
- all new and existing installer tests pass
- syntax checks pass
- no secrets are present in new tests, receipts, logs, or diffs
