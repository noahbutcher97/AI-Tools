import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadWorkspaceConfig } from "./mcp-config.mjs";
import { evaluateUemcpHealth } from "./uemcp-doctor.mjs";

export function runWorkspaceDoctor({ workspaceDir, rootManifest }) {
  const cfg = loadWorkspaceConfig(workspaceDir);
  const report = {
    workspace: resolve(workspaceDir),
    exitCode: 0,
    config: {
      public: summarizeStatus(cfg.publicStatus),
      secret: summarizeStatus(cfg.secretStatus),
      layout: {
        hasPublicMcpServers: isObject(cfg.public.mcpServers),
        hasPublicBridges: isObject(cfg.public.bridges),
        hasSecretBridges: isObject(cfg.secrets.bridges),
        hasSecretMcpServers: isObject(cfg.secrets.mcpServers),
      },
    },
    issues: [],
    bridges: [],
  };

  if (!cfg.publicStatus.exists) {
    addIssue(report, {
      code: "public-config-missing",
      severity: "error",
      message: ".mcp.json is missing",
      file: ".mcp.json",
    });
  }

  for (const error of cfg.parseErrors || []) {
    addIssue(report, {
      code: "config-parse-failed",
      severity: "error",
      message: error.message,
      file: error.file,
      path: error.path,
    });
  }

  if (cfg.hasParseErrors) {
    report.exitCode = 2;
    return report;
  }

  for (const [name, manifestBridge] of Object.entries(rootManifest?.bridges || {})) {
    const bridge = evaluateBridge({ cfg, name, manifestBridge });
    report.bridges.push(bridge);
    for (const issue of bridge.issues) {
      addIssue(report, { bridge: name, ...issue });
    }
  }

  if (report.exitCode !== 2 && report.issues.length > 0) {
    report.exitCode = 1;
  }

  return report;
}

export function formatDoctorReport(report) {
  const lines = [
    `Workspace: ${report.workspace}`,
    `Exit code: ${report.exitCode}`,
    "Config:",
    `  public: ${formatConfigState(report.config.public)}`,
    `  secret: ${formatConfigState(report.config.secret)}`,
    `  layout: public.mcpServers=${report.config.layout.hasPublicMcpServers}, public.bridges=${report.config.layout.hasPublicBridges}, secret.bridges=${report.config.layout.hasSecretBridges}, secret.mcpServers=${report.config.layout.hasSecretMcpServers}`,
    "Bridges:",
  ];

  if (report.bridges.length === 0) {
    lines.push("  (none)");
  }

  for (const bridge of report.bridges) {
    const issueCodes = bridge.issues.map((issue) => issue.code).join(", ") || "ok";
    lines.push(`  ${bridge.name}: ${bridge.status} issues=${issueCodes}`);
  }

  lines.push("Issues:");
  if (report.issues.length === 0) {
    lines.push("  (none)");
  } else {
    for (const issue of report.issues) {
      const target = issue.bridge ? ` bridge=${issue.bridge}` : "";
      const details = formatIssueDetails(issue);
      lines.push(`  ${issue.code} severity=${issue.severity}${target} ${issue.message || ""}${details}`.trimEnd());
    }
  }

  return lines.join("\n");
}

function formatIssueDetails(issue) {
  const details = [];
  if (issue.path) details.push(`path=${issue.path}`);
  if (issue.file) details.push(`file=${issue.file}`);
  if (issue.field) details.push(`field=${issue.field}`);
  if (issue.expected) details.push(`expected=${issue.expected}`);
  if (issue.actual) details.push(`actual=${issue.actual}`);
  if (issue.action) details.push(`action=${issue.action}`);
  return details.length > 0 ? ` (${details.join("; ")})` : "";
}

function evaluateBridge({ cfg, name, manifestBridge }) {
  const bridgeConfig = cfg.public.bridges?.[name] || null;
  const launch = cfg.public.mcpServers?.[name] || null;
  const status = getBridgeStatus(bridgeConfig, launch);
  const bridge = {
    name,
    displayName: manifestBridge?.displayName || name,
    status,
    facts: {},
    issues: [],
  };

  if (status === "conflict") {
    bridge.issues.push({
      code: "disabled-launch-present",
      severity: "error",
      message: "bridge is disabled but still has an mcpServers launch entry",
      action: "remove the launch entry or mark the bridge enabled",
    });
  }

  if (status !== "enabled" && status !== "conflict") {
    return bridge;
  }

  if (!launch) {
    bridge.issues.push({
      code: "launch-entry-missing",
      severity: "error",
      message: "enabled bridge has no mcpServers launch entry",
    });
  } else {
    const serverArg = firstServerArg(launch.args);
    if (!serverArg) {
      bridge.issues.push({
        code: "server-arg-missing",
        severity: "error",
        message: "enabled bridge launch entry has no server path argument",
      });
    }

    const serverPath = serverArg ? resolvePath(serverArg, cfg.publicPath) : null;
    bridge.facts.serverPath = serverPath;

    if (String(launch.command || "").toLowerCase() === "node" && serverPath && !existsSync(serverPath)) {
      bridge.issues.push({
        code: "server-path-missing",
        severity: "error",
        message: `server path does not exist: ${serverPath}`,
        path: serverPath,
      });
    }

    const serverPathExists = serverPath && existsSync(serverPath);
    const bridgeManifest = serverPathExists ? readManifestNearServer(serverPath) : null;
    if (bridgeManifest?.error) {
      bridge.facts.manifestPath = bridgeManifest.path;
      bridge.issues.push({
        code: "manifest-parse-failed",
        severity: "error",
        message: `manifest.json could not be parsed: ${bridgeManifest.error.message}`,
        path: bridgeManifest.path,
        action: "fix the bridge manifest JSON",
      });
    } else if (bridgeManifest) {
      bridge.facts.manifestPath = bridgeManifest.path;
      bridge.facts.manifestVersion = bridgeManifest.data.version || null;
      checkVersion({ bridge, bridgeConfig, manifest: bridgeManifest.data });
      checkRequiredFields({ bridge, cfg, name, launch, bridgeConfig, manifest: bridgeManifest.data });
    } else if (serverPathExists) {
      bridge.issues.push({
        code: "manifest-missing",
        severity: "warning",
        message: `manifest.json was not found beside or above server path: ${serverPath}`,
        path: serverPath,
      });
    }
  }

  if (name === "uemcp") {
    const health = evaluateUemcpHealth({ cfg, bridge });
    bridge.facts = { ...bridge.facts, ...(health.facts || {}) };
    bridge.issues.push(...(health.issues || []));
  }

  return bridge;
}

function checkVersion({ bridge, bridgeConfig, manifest }) {
  const recorded = bridgeConfig?.version;
  const actual = manifest?.version;
  if (recorded && actual && recorded !== actual) {
    bridge.issues.push({
      code: "version-mismatch",
      severity: "warning",
      message: `recorded version ${recorded} does not match manifest version ${actual}`,
      expected: actual,
      actual: recorded,
    });
  }
}

function checkRequiredFields({ bridge, cfg, name, launch, bridgeConfig, manifest }) {
  for (const field of manifest.fields || []) {
    if (!field?.required) continue;

    if (field.secret) {
      if (!hasField(cfg.secrets.bridges?.[name], field.name) && !hasField(cfg.secrets.mcpServers?.[name]?.env, field.name)) {
        bridge.issues.push({
          code: "missing-secret",
          severity: "error",
          message: `required secret field is missing: ${field.name}`,
          field: field.name,
        });
      }
      continue;
    }

    if (!hasField(launch.env, field.name) && !hasField(bridgeConfig, field.name)) {
      bridge.issues.push({
        code: "missing-public-field",
        severity: "error",
        message: `required public field is missing: ${field.name}`,
        field: field.name,
      });
    }
  }
}

function getBridgeStatus(bridgeConfig, launch) {
  if (bridgeConfig?.enabled === false && launch) return "conflict";
  if (bridgeConfig?.enabled === false) return "disabled";
  if (bridgeConfig?.enabled === true || launch) return "enabled";
  return "absent";
}

const nodeFlagsWithValue = new Set([
  "-r",
  "--require",
  "--env-file",
  "--env-file-if-exists",
  "--import",
  "--loader",
  "--experimental-loader",
]);

function firstServerArg(args) {
  if (!Array.isArray(args)) return null;
  let skipNext = false;
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg.startsWith("-")) {
      const [flag] = arg.split("=", 1);
      if (!arg.includes("=") && nodeFlagsWithValue.has(flag)) {
        skipNext = true;
      }
      continue;
    }

    return arg;
  }
  return null;
}

function readManifestNearServer(serverPath) {
  for (const manifestPath of [join(dirname(serverPath), "manifest.json"), join(dirname(dirname(serverPath)), "manifest.json")]) {
    if (!existsSync(manifestPath)) continue;
    try {
      return { path: manifestPath, data: JSON.parse(readFileSync(manifestPath, "utf-8")) };
    } catch (error) {
      return { path: manifestPath, error };
    }
  }
  return null;
}

function resolvePath(path, baseFile) {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return path;
  return resolve(dirname(baseFile), path);
}

function hasField(obj, fieldName) {
  const value = obj?.[fieldName];
  return typeof value === "string" && value.trim() !== "";
}

function summarizeStatus(status) {
  return {
    path: status.path,
    exists: status.exists,
    ok: status.ok,
    error: status.error,
  };
}

function formatConfigState(state) {
  if (!state.exists) return `missing (${state.path})`;
  if (!state.ok) return `parse-failed (${state.path})`;
  return `ok (${state.path})`;
}

function addIssue(report, issue) {
  report.issues.push(issue);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
