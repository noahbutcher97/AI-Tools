import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { safeJoin } from "./safepath.mjs";
import { redactBridgeResult, summarizeResults } from "./install-results.mjs";

const RECEIPT_SCHEMA_VERSION = "1.0";
const RECEIPT_DIR = ".mcp-install-receipts";
const SAFE_FILE_PART = /^[A-Za-z0-9._-]+$/;
const SAFE_CODE = /^[A-Za-z0-9._:-]+$/;

export function serializeReceipt(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  const endedAt = input.endedAt || new Date().toISOString();
  const bridgeResults = Array.isArray(input.bridgeResults) ? input.bridgeResults.map(redactBridgeResult) : [];
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    runId: input.runId || makeRunId(startedAt),
    mode: input.mode,
    startedAt,
    endedAt,
    aiToolsRoot: input.aiToolsRoot,
    workspace: input.workspace,
    selectedBridges: input.selectedBridges || [],
    exitCode: input.exitCode,
    files: input.files || {},
    nextSteps: input.nextSteps || [],
    summary: summarizeResults(bridgeResults),
    bridgeResults,
    doctorSummary: summarizeDoctor(input.doctorSummary),
  };

  return redactBridgeResult(receipt);
}

export function writeInstallReceipt(workspaceDir, input = {}) {
  const receipt = serializeReceipt(input);
  const receiptDir = safeJoin(workspaceDir, RECEIPT_DIR);
  mkdirSync(receiptDir, { recursive: true });

  const fileName = `${safeFilePart(receipt.runId, "runId")}-${safeFilePart(receipt.mode, "mode")}.json`;
  const path = safeJoin(receiptDir, fileName);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
  return { path, receipt };
}

function makeRunId(isoTimestamp) {
  const timestamp = isoTimestamp.replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function safeFilePart(value, label) {
  if (typeof value !== "string" || value.length === 0 || !SAFE_FILE_PART.test(value)) {
    throw new Error(`Receipt ${label} is not safe for a filename.`);
  }
  return value;
}

function summarizeDoctor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const summary = {};
  if (Number.isInteger(value.exitCode)) summary.exitCode = value.exitCode;
  if (Number.isInteger(value.totalIssues)) summary.totalIssues = value.totalIssues;
  const status = safeCode(value.status);
  if (status) summary.status = status;
  const issueCodes = safeCodeArray(value.issueCodes);
  if (issueCodes) summary.issueCodes = issueCodes;
  const issuesBySeverity = safeCountMap(value.issuesBySeverity);
  if (issuesBySeverity) summary.issuesBySeverity = issuesBySeverity;
  const bridgeStatuses = safeCountMap(value.bridgeStatuses);
  if (bridgeStatuses) summary.bridgeStatuses = bridgeStatuses;

  return Object.keys(summary).length > 0 ? summary : null;
}

function safeCodeArray(value) {
  if (!Array.isArray(value)) return null;
  const codes = value.map(safeCode).filter(Boolean);
  return codes.length > 0 ? codes : null;
}

function safeCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [key, count] of Object.entries(value)) {
    const safeKey = safeCode(key);
    if (!safeKey || !Number.isInteger(count)) continue;
    out[safeKey] = count;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function safeCode(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SAFE_CODE.test(trimmed) ? trimmed : null;
}
