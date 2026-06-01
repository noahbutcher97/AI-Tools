export const RESULT_STATUS = Object.freeze({
  OK: "ok",
  PARTIAL: "partial",
  FAILED: "failed",
  SKIPPED: "skipped",
  DISABLED: "disabled",
  ABSENT: "absent",
});

const DEFAULT_SEVERITY_BY_STATUS = Object.freeze({
  [RESULT_STATUS.OK]: "info",
  [RESULT_STATUS.PARTIAL]: "warning",
  [RESULT_STATUS.FAILED]: "error",
  [RESULT_STATUS.SKIPPED]: "info",
  [RESULT_STATUS.DISABLED]: "info",
  [RESULT_STATUS.ABSENT]: "warning",
});

const SECRET_KEY_PATTERN = /token|password|passwd|passphrase/i;
const SECRET_ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_]*(?:token|password|passwd|passphrase)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:(?!\s+(?:and\s+)?[A-Za-z0-9_]*(?:token|password|passwd|passphrase)[A-Za-z0-9_]*\s*[:=])[^,;\r\n])+)/gi;
const REDACTED_VALUE = "[redacted]";
const VALID_STATUSES = new Set(Object.values(RESULT_STATUS));

export function createBridgeResult(bridge, opts = {}) {
  return {
    bridge,
    requested: Boolean(opts.requested),
    previouslyEnabled: Boolean(opts.previouslyEnabled),
    status: RESULT_STATUS.SKIPPED,
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
  if (typeof action !== "string") return result;

  const trimmed = action.trim();
  if (trimmed && !result.actions.includes(trimmed)) {
    result.actions.push(trimmed);
  }
  return result;
}

export function finalizeBridgeResult(result, status, opts = {}) {
  assertValidStatus(status);

  result.status = status;
  result.severity = opts.severity || DEFAULT_SEVERITY_BY_STATUS[status] || "info";

  addAction(result, opts.action);
  for (const action of opts.actions || []) {
    addAction(result, action);
  }

  return result;
}

export function summarizeResults(results) {
  const summary = {
    total: results.length,
    byStatus: {},
    bySeverity: {},
  };

  for (const result of results) {
    increment(summary.byStatus, result.status);
    increment(summary.bySeverity, result.severity);
  }

  return summary;
}

export function exitCodeForResults(results, opts = {}) {
  if (opts.usageError) return 2;

  return results.some((result) => (
    (result.requested || result.previouslyEnabled)
    && (result.status === RESULT_STATUS.FAILED || result.status === RESULT_STATUS.PARTIAL)
  )) ? 1 : 0;
}

export function validateRequestedBridges(requested, rootManifest) {
  const bridgeCatalog = rootManifest?.bridges || {};
  const unknown = [...new Set(requested || [])]
    .filter((bridge) => !Object.hasOwn(bridgeCatalog, bridge));

  return {
    ok: unknown.length === 0,
    unknown,
    exitCode: unknown.length > 0 ? 2 : 0,
  };
}

export function redactBridgeResult(result) {
  return redactValue(result);
}

export function formatInstallSummary(results, exitCode) {
  const summary = summarizeResults(results);
  const statusText = Object.entries(summary.byStatus)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ") || "none";
  const severityText = Object.entries(summary.bySeverity)
    .map(([severity, count]) => `${severity}: ${count}`)
    .join(", ") || "none";
  const actions = results.flatMap((result) => (
    result.actions.map((action) => `${result.bridge}: ${redactString(action)}`)
  ));

  const lines = [
    `MCP Suite install summary: ${summary.total} bridge result(s), exit ${exitCode}.`,
    `Status: ${statusText}.`,
    `Severity: ${severityText}.`,
  ];

  if (actions.length > 0) {
    lines.push("Actions:");
    lines.push(...actions.map((action) => `- ${action}`));
  }

  return lines.join("\n");
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function assertValidStatus(status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid result status: ${status}`);
  }
}

function redactValue(value, key = "") {
  if (Array.isArray(value)) {
    if (key === "secretFields") {
      return value.map((entry) => redactSecretField(entry));
    }
    return value.map((entry) => redactValue(entry));
  }

  if (!value || typeof value !== "object") {
    if (SECRET_KEY_PATTERN.test(key)) return REDACTED_VALUE;
    return typeof value === "string" ? redactString(value) : value;
  }

  const redacted = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === "secretFields" && Array.isArray(entryValue)) {
      redacted[entryKey] = entryValue.map((entry) => redactSecretField(entry));
    } else if (SECRET_KEY_PATTERN.test(entryKey)) {
      redacted[entryKey] = REDACTED_VALUE;
    } else {
      redacted[entryKey] = redactValue(entryValue, entryKey);
    }
  }
  return redacted;
}

function redactSecretField(field) {
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    return field;
  }

  const redacted = {};
  for (const [key, value] of Object.entries(field)) {
    if (key === "value") continue;
    redacted[key] = redactValue(value, key);
  }
  return redacted;
}

function redactString(value) {
  return value.replace(SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED_VALUE}`);
}
