import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";

// ───────────────────────────────────────────────────────────────────────
// Load + validate config via shared 3-tier resolver
// ───────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf-8"));
loadBridgeConfigOrExit("perforce", manifest.fields);

const P4PORT = process.env.P4PORT;
const P4USER = process.env.P4USER;
const P4CLIENT = process.env.P4CLIENT;
const P4DEPOT = process.env.P4DEPOT;
const P4_BASE_ARGS = ["-p", P4PORT, "-u", P4USER, "-c", P4CLIENT];
const DEPOT_ROOT = `//${P4DEPOT}/...`;

// ───────────────────────────────────────────────────────────────────────
// Auto-login if P4PASSWD is set
// ───────────────────────────────────────────────────────────────────────

const P4PASSWD = process.env.P4PASSWD;
if (P4PASSWD) {
  try {
    execFileSync("p4", [...P4_BASE_ARGS, "login"], {
      input: P4PASSWD + "\n",
      encoding: "utf-8",
      timeout: 15000,
    });
    console.error(`[perforce-bridge] Logged in as ${P4USER} @ ${P4PORT}`);
  } catch (err) {
    console.error(`[perforce-bridge] Login attempt: ${(err.stderr || err.message).trim()}`);
  }
}

// ───────────────────────────────────────────────────────────────────────
// p4 command runner
// ───────────────────────────────────────────────────────────────────────

function p4(cmdArgs, opts = {}) {
  const timeout = opts.timeout || 30000;
  try {
    const result = execFileSync("p4", [...P4_BASE_ARGS, ...cmdArgs], {
      encoding: "utf-8",
      timeout,
      maxBuffer: 1024 * 1024 * 5,
    });
    return { ok: true, output: result.trim() };
  } catch (err) {
    const message = (err.stderr || err.message || "Unknown error").trim();
    return { ok: false, output: message };
  }
}

function toolResult(result) {
  if (result.ok) {
    return { content: [{ type: "text", text: result.output || "(no output)" }] };
  }
  return { content: [{ type: "text", text: result.output }], isError: true };
}

// ───────────────────────────────────────────────────────────────────────
// MCP server + tools
// ───────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "perforce-bridge",
  version: "1.0.0",
  description: `Perforce Bridge for ${P4USER}@${P4PORT} (depot: //${P4DEPOT}/...)`,
});

server.tool(
  "connection_info",
  "Show Perforce connection details: server, user, client workspace, depot root",
  {},
  async () => {
    const info = p4(["info"]);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              server: P4PORT,
              user: P4USER,
              client: P4CLIENT,
              depot: `//${P4DEPOT}/...`,
              status: info.ok ? "connected" : "error",
              serverInfo: info.ok ? info.output : info.output,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "p4_opened",
  "List files currently opened for edit/add/delete in the workspace.",
  { changelist: z.string().optional().describe("Changelist number to filter by") },
  async ({ changelist }) => {
    const cmdArgs = ["opened"];
    if (changelist) cmdArgs.push("-c", changelist);
    return toolResult(p4(cmdArgs));
  },
);

server.tool(
  "p4_changes",
  `List recent changelists. Defaults to last 10 submitted by ${P4USER}.`,
  {
    max: z.number().optional().default(10).describe("Max changelists to return"),
    user: z.string().optional().describe(`Filter by user (default: ${P4USER})`),
    status: z.enum(["submitted", "pending"]).optional().default("submitted"),
  },
  async ({ max, user, status }) => {
    return toolResult(
      p4(["changes", "-s", status, "-u", user || P4USER, "-m", String(max), DEPOT_ROOT]),
    );
  },
);

server.tool(
  "p4_describe",
  "Show full details of a changelist — description, files, diffs.",
  {
    changelist: z.string().describe("Changelist number"),
    summaryOnly: z.boolean().optional().default(false),
  },
  async ({ changelist, summaryOnly }) => {
    const cmdArgs = ["describe"];
    if (summaryOnly) cmdArgs.push("-s");
    cmdArgs.push(changelist);
    return toolResult(p4(cmdArgs, { timeout: 60000 }));
  },
);

server.tool(
  "p4_diff",
  "Show diffs for opened files. Optionally filter by path.",
  { path: z.string().optional() },
  async ({ path }) => {
    const cmdArgs = ["diff"];
    if (path) cmdArgs.push(path);
    return toolResult(p4(cmdArgs, { timeout: 60000 }));
  },
);

server.tool(
  "p4_filelog",
  "Show revision history for a file.",
  {
    path: z.string().describe("Depot or local file path"),
    max: z.number().optional().default(5),
  },
  async ({ path, max }) => {
    return toolResult(p4(["filelog", "-m", String(max), path]));
  },
);

server.tool(
  "p4_reconcile_preview",
  "Preview reconcile (offline adds/edits/deletes) without opening files. Dry run.",
  { path: z.string().optional() },
  async ({ path }) => {
    return toolResult(p4(["reconcile", "-n", path || `//${P4DEPOT}/Source/...`], { timeout: 60000 }));
  },
);

server.tool(
  "p4_fstat",
  "Show detailed file status — depot path, action, head revision, etc.",
  { path: z.string().describe("File or path to stat") },
  async ({ path }) => toolResult(p4(["fstat", path])),
);

server.tool(
  "p4_changelists",
  "List pending changelists in the workspace.",
  {},
  async () => toolResult(p4(["changes", "-s", "pending", "-c", P4CLIENT, DEPOT_ROOT])),
);

server.tool(
  "p4_sync",
  "Sync files from the depot. Large syncs may take minutes.",
  { path: z.string().optional() },
  async ({ path }) => toolResult(p4(["sync", path || DEPOT_ROOT], { timeout: 120000 })),
);

server.tool(
  "p4_resolve",
  "Resolve files after sync. WARNING: 'at'/'ay' overwrite without confirmation.",
  {
    mode: z.enum(["am", "at", "ay"]).describe("am=auto-merge, at=accept theirs, ay=accept yours"),
    path: z.string().optional(),
  },
  async ({ mode, path }) => {
    const cmdArgs = ["resolve", `-${mode}`];
    if (path) cmdArgs.push(path);
    return toolResult(p4(cmdArgs, { timeout: 60000 }));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[perforce-bridge] running ${P4USER}@${P4PORT} client=${P4CLIENT} depot=//${P4DEPOT}/...`);
