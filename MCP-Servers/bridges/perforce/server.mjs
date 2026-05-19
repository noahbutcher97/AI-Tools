import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";
import { toolTextResult, toolErrorResult } from "../../lib/tool-result.mjs";
import {
  parseOpenedFiles,
  parseChangeSpecDescription,
  parseSubmittedChangelist,
  normalizeDescription,
  CL_LINE_RE,
} from "./parsers.mjs";

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
  return result.ok ? toolTextResult(result.output) : toolErrorResult(result.output);
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

server.tool(
  "p4_reconcile",
  "Open files for add/edit/delete based on workspace state vs depot. "
    + "Required `path` — no workspace-wide default; caller must scope explicitly. "
    + "preview=true (default) runs `p4 reconcile -n` and returns what WOULD be opened. "
    + "Set preview=false to actually open the files. "
    + "Use `changelist` (numeric) to drop opened files into a specific pending CL; omit for default CL.",
  {
    path: z
      .string()
      .min(1)
      .describe(
        "Depot or local path to reconcile (e.g. '//OnSight/Source/OnSightTests/...'). "
          + "No default — caller must scope explicitly.",
      ),
    preview: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "If true (default), run as dry-run with `-n` — files are NOT opened. "
          + "Set to false to actually open files for add/edit/delete.",
      ),
    changelist: z
      .string()
      .optional()
      .describe(
        "Numeric pending CL to put opened files into. Omit (or pass 'default') for the default CL.",
      ),
  },
  async ({ path, preview, changelist }) => {
    if (changelist !== undefined && changelist !== "default" && !/^\d+$/.test(changelist)) {
      return toolErrorResult(
        `Invalid changelist '${changelist}'. Must be numeric, 'default', or omitted.`,
      );
    }
    const args = ["reconcile"];
    if (preview) args.push("-n");
    if (changelist && changelist !== "default") args.push("-c", changelist);
    args.push(path);
    return toolResult(p4(args, { timeout: 120000 }));
  },
);

server.tool(
  "p4_submit",
  "Submit a pending or default changelist with explicit description verification. "
    + "For numbered CLs the provided description must match the CL spec's existing description "
    + "(after whitespace/line-ending normalization — no clobber; caller must set description on the CL beforehand). "
    + "For 'default', the description is passed via `p4 submit -d`. "
    + "preview=true runs spec / opened / unresolved / out-of-date checks without submitting.",
  {
    changelist: z
      .string()
      .min(1)
      .describe("Pending changelist number, or the literal string 'default'."),
    description: z
      .string()
      .min(1)
      .describe(
        "Submit description. For numbered CLs, must exactly match the CL spec's existing description.",
      ),
    preview: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, run pre-submit validation only (no submit performed)."),
  },
  async ({ changelist, description, preview }) => {
    const cl = changelist.trim();
    const isDefault = cl === "default";
    const desc = normalizeDescription(description);

    if (desc.length === 0) {
      return {
        content: [{ type: "text", text: "Description must be non-empty after trimming whitespace." }],
        isError: true,
      };
    }

    if (!isDefault && !/^\d+$/.test(cl)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid changelist '${cl}'. Must be a numeric pending changelist or 'default'.`,
          },
        ],
        isError: true,
      };
    }

    // Verify-match: for numbered CLs, refuse to submit unless the provided
    // description equals the CL spec's existing description. This prevents
    // any accidental clobber of a carefully-crafted description.
    if (!isDefault) {
      const specResult = p4(["change", "-o", cl]);
      if (!specResult.ok) {
        return {
          content: [{ type: "text", text: `Failed to read CL spec for ${cl}:\n${specResult.output}` }],
          isError: true,
        };
      }
      const existing = normalizeDescription(parseChangeSpecDescription(specResult.output));
      if (existing !== desc) {
        return {
          content: [
            {
              type: "text",
              text:
                `Description mismatch on CL ${cl} — refusing submit to prevent clobber.\n\n`
                + `--- CL ${cl} description (existing) ---\n${existing || "(empty)"}\n\n`
                + `--- Provided description ---\n${desc}\n\n`
                + `Resolution: update the CL description on the spec (e.g. \`p4 change ${cl}\`) so it matches, then retry.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Preview mode: surface the four pre-submit checks and stop.
    if (preview) {
      const sections = [];

      if (isDefault) {
        sections.push("=== Change spec ===\n(default changelist — no spec; description passed via `p4 submit -d`)");
      } else {
        const spec = p4(["change", "-o", cl]);
        sections.push(`=== Change spec (CL ${cl}) ===\n${spec.output}`);
      }

      // Scope to the specific CL (including 'default'). We pass -c for the
      // server's benefit, but DO NOT trust it — some Perforce versions ignore
      // the literal 'default' here and return workspace-wide files. So we
      // additionally filter the output by the CL marker that p4 always emits
      // on each opened line: " - <action> default change " or
      // " - <action> change <N> ". That format is stable across versions.
      const scopedCl = isDefault ? "default" : cl;

      // Fixed-literal regex (no dynamic construction → no ReDoS surface).
      // Captures the CL identifier from each `p4 opened` line; we then
      // string-compare it to scopedCl rather than interpolating into a regex.
      const lineMatchesScope = (line) => {
        const m = CL_LINE_RE.exec(line);
        if (!m) return false;
        return (m[1] || m[2]) === scopedCl;
      };

      const openedRaw = p4(["opened", "-c", scopedCl]);
      const openedText = openedRaw.ok
        ? (openedRaw.output || "")
            .split(/\r?\n/)
            .filter(lineMatchesScope)
            .join("\n")
        : "";

      if (!openedRaw.ok) {
        sections.push(`=== Files in CL ===\nCheck failed: ${openedRaw.output}`);
      } else {
        sections.push(`=== Files in CL ===\n${openedText || "(none)"}`);
      }

      const files = parseOpenedFiles(openedText);

      // Unresolved check — pass the filtered file list explicitly rather than
      // relying on `resolve -n -c default` (whose semantics vary by server).
      // Chunk to stay under CreateProcessW's argv limit.
      const CHUNK = 50;
      let unresolvedText;
      if (files.length === 0) {
        unresolvedText = "(skipped — no files in CL)";
      } else {
        const unresolvedOutputs = [];
        let resolveFailure = null;
        for (let i = 0; i < files.length && !resolveFailure; i += CHUNK) {
          const slice = files.slice(i, i + CHUNK);
          const r = p4(["resolve", "-n", ...slice], { timeout: 60000 });
          if (r.ok) {
            if (r.output) unresolvedOutputs.push(r.output);
          } else if (/no file\(s\) to resolve/i.test(r.output)) {
            // Benign — nothing in this slice needs resolution.
          } else {
            resolveFailure = r.output;
          }
        }
        if (resolveFailure) {
          unresolvedText = `Check failed: ${resolveFailure}`;
        } else if (unresolvedOutputs.length === 0) {
          unresolvedText = "OK — no files need resolution.";
        } else {
          unresolvedText = `WARNING — files need resolution:\n${unresolvedOutputs.join("\n")}`;
        }
      }
      sections.push(`=== Unresolved check ===\n${unresolvedText}`);

      // Out-of-date check — same chunked-file-list pattern.
      let oodText;
      if (files.length === 0) {
        oodText = "(skipped — no files in CL)";
      } else {
        const oodOutputs = [];
        let checkFailure = null;
        for (let i = 0; i < files.length && !checkFailure; i += CHUNK) {
          const slice = files.slice(i, i + CHUNK);
          const r = p4(["sync", "-n", ...slice], { timeout: 60000 });
          if (r.ok) {
            if (r.output) oodOutputs.push(r.output);
          } else if (/file\(s\) up-to-date/i.test(r.output)) {
            // Benign — `p4 sync -n` exits non-zero with this sentinel.
          } else {
            checkFailure = r.output;
          }
        }
        if (checkFailure) {
          oodText = `Check failed: ${checkFailure}`;
        } else if (oodOutputs.length === 0) {
          oodText = "OK — files up-to-date.";
        } else {
          const combined = oodOutputs.join("\n");
          oodText = /^\S.*#\d+/m.test(combined)
            ? `WARNING — out-of-date files:\n${combined}`
            : combined;
        }
      }
      sections.push(`=== Out-of-date check ===\n${oodText}`);

      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    }

    // Actual submit. Numbered CL uses the spec's description (already verified);
    // default uses -d with the provided description. No -f, no auto-reopen.
    const submitArgs = isDefault ? ["submit", "-d", desc] : ["submit", "-c", cl];
    const result = p4(submitArgs, { timeout: 120000 });

    if (!result.ok) {
      return { content: [{ type: "text", text: result.output }], isError: true };
    }

    const submittedCl = parseSubmittedChangelist(result.output);
    const header = submittedCl
      ? `Submitted changelist ${submittedCl}`
      : "Submit completed (could not parse submitted CL number from output)";

    return { content: [{ type: "text", text: `${header}\n\n${result.output}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[perforce-bridge] running ${P4USER}@${P4PORT} client=${P4CLIENT} depot=//${P4DEPOT}/...`);
