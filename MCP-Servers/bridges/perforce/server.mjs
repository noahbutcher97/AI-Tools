import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";
import { toolTextResult, toolErrorResult, toolJsonResult } from "../../lib/tool-result.mjs";
import {
  parseOpenedFiles,
  parseChangeSpecDescription,
  parseSubmittedChangelist,
  parseCreatedChangelist,
  normalizeDescription,
  CL_LINE_RE,
  buildCreateChangeSpec,
  buildEditArgs,
  buildRevertArgs,
  buildLockArgs,
  buildUnlockArgs,
  buildAddArgs,
  buildDeleteArgs,
  buildShelveArgs,
  buildUnshelveArgs,
  buildIntegrateArgs,
  buildMergeArgs,
  buildCopyArgs,
  replaceDescriptionInSpec,
  buildReopenArgs,
  buildMoveArgs,
  buildChangesArgs,
  parseUsersOutput,
  parseGroupsOutput,
  parseGroupSpec,
  parseLoginStatus,
  parseProtectsMax,
  buildUsersArgs,
  buildGroupsArgs,
  buildGroupInfoArgs,
  buildLoginStatusArgs,
  buildProtectsArgs,
  applyGroupSpecChanges,
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
// Admin WRITE tools are opt-in: they mutate server-global state and require
// `super`. Default install stays workspace-scoped. See manifest P4_ENABLE_ADMIN.
const ADMIN_WRITES_ENABLED = String(process.env.P4_ENABLE_ADMIN || "").trim().toLowerCase() === "true";

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
  const isBinary = opts.encoding === "buffer";
  const execOptions = {
    encoding: isBinary ? "buffer" : "utf-8",
    timeout,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 5,
  };
  if (opts.input !== undefined) execOptions.input = opts.input;
  try {
    const result = execFileSync("p4", [...P4_BASE_ARGS, ...cmdArgs], execOptions);
    // Binary mode returns the raw Buffer verbatim — trimming would corrupt content.
    return { ok: true, output: isBinary ? result : result.trim() };
  } catch (err) {
    // In binary mode err.stderr is a Buffer; decode for the error message.
    let message;
    if (err.stderr !== undefined) {
      message = (Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : err.stderr).trim();
    } else {
      message = (err.message || "Unknown error").trim();
    }
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
  "p4_info",
  "Show Perforce connection details: server, user, client workspace, depot root (`p4 info`).",
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
  `List changelists from \`p4 changes\`. Defaults to the last 10 submitted by ${P4USER}. `
    + `Set status='pending' for pending CLs. Filter by \`user\` (any user), or by \`client\` `
    + `to list changes in a specific workspace — pass client='${P4CLIENT}' for this workspace's `
    + `pending CLs (any user). With neither user nor client, defaults to ${P4USER}.`,
  {
    max: z.number().optional().default(10).describe("Max changelists to return"),
    user: z.string().optional().describe(`Filter by user. Omit (with no client) to default to ${P4USER}.`),
    client: z
      .string()
      .optional()
      .describe(`Filter by client/workspace (e.g. '${P4CLIENT}'). When set, does not force the user filter.`),
    status: z.enum(["submitted", "pending"]).optional().default("submitted"),
  },
  async ({ max, user, client, status }) => {
    return toolResult(
      p4(buildChangesArgs({ status, max, user, client, defaultUser: P4USER, depotRoot: DEPOT_ROOT })),
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
  "p4_print",
  "Read depot file content at any revision (`p4 print`). "
    + "The path may include a revision spec: '//depot/foo.cpp#42' (revision), '//depot/foo.cpp@CL' (at-CL), "
    + "or '//depot/foo.cpp@label'. Without a spec, returns the head revision. "
    + "Text mode (default) decodes as UTF-8 and is appropriate for source files. "
    + "Set `binary=true` for non-UTF-8 content (compiled binaries, images, Unreal .uasset/.umap) — "
    + "returns JSON with base64-encoded bytes and a length field. Binary mode auto-suppresses "
    + "p4's text header so the decoded bytes ARE the file content. "
    + "Use `quiet=true` in text mode to suppress the leading depot-path/revision header.",
  {
    path: z.string().min(1).describe("Depot path, optionally with revision spec (#rev, @CL, @label)."),
    quiet: z.boolean().optional().default(false).describe("If true, pass `-q` to suppress the header (text mode only — binary mode forces -q)."),
    binary: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, return base64-encoded bytes wrapped in JSON. Required for non-UTF-8 content."),
  },
  async ({ path, quiet, binary }) => {
    const args = ["print"];
    // Binary mode: always pass -q so the returned bytes are exactly the file
    // content, with no p4 text header prefix to corrupt the decode.
    if (binary || quiet) args.push("-q");
    args.push(path);

    if (!binary) {
      return toolResult(p4(args, { timeout: 60000 }));
    }

    // 50MB cap is generous for typical .uasset / image files; larger blobs
    // fail with a clear maxBuffer error rather than silently truncating.
    const result = p4(args, { timeout: 60000, encoding: "buffer", maxBuffer: 1024 * 1024 * 50 });
    if (!result.ok) return toolErrorResult(result.output);

    const buf = result.output;
    return toolTextResult(
      JSON.stringify(
        {
          encoding: "base64",
          bytes: buf.length,
          data: buf.toString("base64"),
        },
        null,
        2,
      ),
    );
  },
);

server.tool(
  "p4_annotate",
  "Show line-by-line revision history for a file (`p4 annotate` — Perforce's blame). "
    + "Pairs with `p4_filelog` (revision-level history): annotate tells you *which* CL last touched *each line*.",
  {
    path: z.string().min(1).describe("Depot or local file path."),
    includeDeleted: z.boolean().optional().default(false).describe("Pass `-a`: include lines from deleted revisions."),
    changesOnly: z.boolean().optional().default(false).describe("Pass `-c`: show CL numbers only (no user/date)."),
    ignoreWhitespace: z.boolean().optional().default(false).describe("Pass `-w`: ignore whitespace-only changes."),
    followIntegrations: z.boolean().optional().default(false).describe("Pass `-I`: follow integration history."),
  },
  async ({ path, includeDeleted, changesOnly, ignoreWhitespace, followIntegrations }) => {
    const args = ["annotate"];
    if (includeDeleted) args.push("-a");
    if (changesOnly) args.push("-c");
    if (ignoreWhitespace) args.push("-w");
    if (followIntegrations) args.push("-I");
    args.push(path);
    return toolResult(p4(args, { timeout: 60000 }));
  },
);

server.tool(
  "p4_fstat",
  "Show detailed file status — depot path, action, head revision, etc.",
  { path: z.string().describe("File or path to stat") },
  async ({ path }) => toolResult(p4(["fstat", path])),
);

server.tool(
  "p4_where",
  "Translate between depot and local workspace paths (`p4 where`). "
    + "Given a depot path returns the workspace path (and vice versa). "
    + "Useful when you have a path in one form and need the other (e.g. an LLM has a local path "
    + "from a previous tool call and needs the depot path to pass to a mutation tool).",
  { path: z.string().min(1).describe("Depot or local path to map.") },
  async ({ path }) => toolResult(p4(["where", path])),
);

server.tool(
  "p4_have",
  "List files synced into this workspace and their revisions (`p4 have`). "
    + "Required `path` — `p4 have //depot/...` can return tens of thousands of lines; caller must scope.",
  { path: z.string().min(1).describe("Depot or local path to query.") },
  async ({ path }) => toolResult(p4(["have", path], { timeout: 60000 })),
);

// ───────────────────────────────────────────────────────────────────────
// Admin / identity tier (read-only). Unlike every other tool here, these
// report on the WHOLE Perforce server, not //P4DEPOT/... — so each response
// is wrapped with scope:"server-global" (and a warning when unscoped) per the
// scope-leak audit convention. The injected `-c P4CLIENT` is ignored by these
// commands. See _handoffs/2026-05-29-perforce-admin-tier.md.
// ───────────────────────────────────────────────────────────────────────

server.tool(
  "p4_users",
  "List Perforce user accounts (`p4 users`). Resolves a display name/handle to "
    + "the real login and shows email, full name, and last access. Omit `user` to "
    + "list every account on the server (server-global). Pass one or more usernames "
    + "to look up specific accounts.",
  {
    user: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Username or list of usernames to look up. Omit to list all users (server-wide)."),
  },
  async ({ user }) => {
    const result = p4(buildUsersArgs({ user }));
    if (!result.ok) return toolErrorResult(result.output);
    const scoped = user === undefined || user === null || (Array.isArray(user) && user.length === 0);
    return toolJsonResult({
      scope: "server-global",
      ...(scoped ? { warning: "No user filter — lists every account on the server." } : {}),
      users: parseUsersOutput(result.output),
    });
  },
);

server.tool(
  "p4_groups",
  "List Perforce groups (`p4 groups`). Pass `user` to list that user's group "
    + "memberships (answers 'is this user already in a no-timeout group?'); omit it "
    + "to list every group on the server (server-global).",
  {
    user: z.string().optional().describe("List groups this user belongs to. Omit to list all groups (server-wide)."),
  },
  async ({ user }) => {
    const result = p4(buildGroupsArgs({ user }));
    if (!result.ok) return toolErrorResult(result.output);
    const scoped = user === undefined || user === null || user === "";
    return toolJsonResult({
      scope: "server-global",
      ...(scoped ? { warning: "No user filter — lists every group on the server." } : {}),
      groups: parseGroupsOutput(result.output),
    });
  },
);

server.tool(
  "p4_group_info",
  "Read a Perforce group spec (`p4 group -o <name>`). Returns the group's "
    + "Timeout (ticket lifetime), member Users/Owners/Subgroups, and resource "
    + "limits (MaxResults/MaxScanRows/MaxLockTime — 'unset' means no limit). "
    + "Read-only; does not create or modify the group.",
  {
    group: z.string().min(1).describe("Group name to read."),
  },
  async ({ group }) => {
    const result = p4(buildGroupInfoArgs({ group }));
    if (!result.ok) return toolErrorResult(result.output);
    return toolJsonResult({ scope: "server-global", ...parseGroupSpec(result.output) });
  },
);

server.tool(
  "p4_login_status",
  "Check Perforce login ticket status (`p4 login -s`). Reports whether the "
    + "ticket is valid and roughly how long until it expires — the tool to reach "
    + "for when a user reports being logged out / a recurring re-login 'cooldown'. "
    + "Omit `user` for the connected account.",
  {
    user: z.string().optional().describe("Check this user's ticket (super access required for other users). Omit for the connected user."),
  },
  async ({ user }) => {
    const result = p4(buildLoginStatusArgs({ user }));
    // An expired/absent ticket exits non-zero; classify it rather than erroring,
    // since "expired" is a valid, informative answer here.
    const parsed = parseLoginStatus(result.output);
    return toolJsonResult({ scope: "server-global", ...parsed });
  },
);

server.tool(
  "p4_protects",
  "Inspect Perforce protections (`p4 protects`). With `max:true` returns the "
    + "effective maximum access level (list/read/open/write/admin/super) — the "
    + "capability probe that answers 'can this user perform an admin action "
    + "themselves?'. Without `max`, returns the raw protection lines that apply. "
    + "Targeting another `user` requires super access.",
  {
    max: z.boolean().optional().default(false).describe("Pass -m: return only the effective max access level."),
    user: z.string().optional().describe("Report protections for this user (super access required). Omit for the connected user."),
  },
  async ({ max, user }) => {
    const result = p4(buildProtectsArgs({ max, user }));
    if (!result.ok) return toolErrorResult(result.output);
    if (max) {
      return toolJsonResult({ scope: "server-global", maxAccessLevel: parseProtectsMax(result.output) });
    }
    return toolJsonResult({ scope: "server-global", protections: result.output });
  },
);

server.tool(
  "p4_create_changelist",
  "Create a new numbered pending changelist with an explicit description. "
    + "Uses `p4 change -i`; the returned output includes the created CL number.",
  {
    description: z
      .string()
      .min(1)
      .describe("Pending changelist description. Required and normalized before writing the spec."),
  },
  async ({ description }) => {
    let spec;
    try {
      spec = buildCreateChangeSpec({ client: P4CLIENT, description });
    } catch (e) {
      return toolErrorResult(e.message);
    }

    const result = p4(["change", "-i"], { input: spec, timeout: 60000 });
    if (!result.ok) return toolErrorResult(result.output);

    const created = parseCreatedChangelist(result.output);
    const header = created
      ? `Created pending changelist ${created}`
      : "Created pending changelist (could not parse CL number from output)";
    return toolTextResult(`${header}\n\n${result.output}`);
  },
);

server.tool(
  "p4_update_changelist",
  "Update the description on an existing pending changelist. "
    + "Surgically rewrites only the `Description:` block in the CL spec via `p4 change -o` / `p4 change -i`, "
    + "preserving every other field (Files, Jobs, Type, Status, etc.) — including any field another tool "
    + "or the user has populated on the spec.",
  {
    changelist: z.string().min(1).describe("Numeric pending changelist to update."),
    description: z.string().min(1).describe("New description. Normalized before writing the spec."),
  },
  async ({ changelist, description }) => {
    const cl = String(changelist).trim();
    if (!/^\d+$/.test(cl)) {
      return toolErrorResult(`Invalid changelist '${cl}'. Must be a numeric pending changelist.`);
    }

    const specResult = p4(["change", "-o", cl]);
    if (!specResult.ok) return toolErrorResult(specResult.output);

    let updatedSpec;
    try {
      updatedSpec = replaceDescriptionInSpec(specResult.output, description);
    } catch (e) {
      return toolErrorResult(e.message);
    }

    const writeResult = p4(["change", "-i"], { input: updatedSpec, timeout: 60000 });
    if (!writeResult.ok) return toolErrorResult(writeResult.output);
    return toolTextResult(`Updated description on changelist ${cl}\n\n${writeResult.output}`);
  },
);

server.tool(
  "p4_delete_changelist",
  "Delete an empty pending changelist (`p4 change -d`). "
    + "Perforce will refuse if the CL has open files or shelved files — revert/unshelve first. "
    + "Cannot delete submitted CLs (use `p4 change -df` from the CLI as admin if you really need to).",
  {
    changelist: z.string().min(1).describe("Numeric pending changelist to delete."),
  },
  async ({ changelist }) => {
    const cl = String(changelist).trim();
    if (!/^\d+$/.test(cl)) {
      return toolErrorResult(`Invalid changelist '${cl}'. Must be a numeric pending changelist.`);
    }
    return toolResult(p4(["change", "-d", cl], { timeout: 30000 }));
  },
);

server.tool(
  "p4_reopen",
  "Reopen already-opened files to change their pending changelist and/or Perforce filetype (`p4 reopen`). "
    + "At least one of `changelist` or `filetype` must be supplied — bare reopen is a no-op. "
    + "`changelist` (numeric, or 'default') moves the open into that pending CL — the CL must already exist; "
    + "use 'default' to move files back to the default changelist. "
    + "`filetype` retypes the open (e.g. 'binary+l' to make an Unreal .uasset exclusively-locked, "
    + "'text+w' for always-writable text); it is validated against the same base-type + modifier allowlist as `p4_add`. "
    + "Supply both to move and retype in a single call. Files must already be open in this workspace.",
  {
    files: z
      .array(z.string().min(1))
      .min(1)
      .describe("Explicit depot or local file paths of already-opened files to reopen."),
    changelist: z
      .string()
      .optional()
      .describe("Numeric pending CL to move the open into, or 'default'. Omit to leave the CL unchanged."),
    filetype: z
      .string()
      .optional()
      .describe("New Perforce filetype (e.g. 'binary+l', 'text+w', '+S2'). Omit to leave the type unchanged."),
  },
  async ({ files, changelist, filetype }) => {
    let args;
    try {
      args = buildReopenArgs({ changelist, filetype, files });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
  },
);

server.tool(
  "p4_move",
  "Open a Perforce move/rename using `p4 move`. "
    + "By default this previews with `p4 move -n`; set preview=false to actually open the move. "
    + "Use changelist to put the pending move into an existing numbered CL. "
    + "Use recursive=true for strict rename mode (`p4 move -r`) on matching wildcard paths.",
  {
    source: z.string().min(1).describe("Source depot or local file path."),
    target: z.string().min(1).describe("Target depot or local file path."),
    changelist: z
      .string()
      .optional()
      .describe("Optional numeric pending changelist. Pass 'default' or omit to use default CL."),
    preview: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true (default), run `p4 move -n` and do not open the move."),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, include `-r` for strict rename mode with matching wildcard paths."),
  },
  async ({ source, target, changelist, preview, recursive }) => {
    let args;
    try {
      args = buildMoveArgs({ source, target, changelist, preview, recursive });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
  },
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
  "p4_edit",
  "Open existing depot files for edit (direct checkout — `p4 edit`). "
    + "Unlike `p4_reconcile`, this is path-driven not state-driven: caller names the files "
    + "to check out, regardless of whether they've already been modified on disk. "
    + "Defaults to actually opening the files (preview=false) since the caller has explicitly "
    + "named them. Set preview=true to dry-run with `p4 edit -n`. "
    + "Use `changelist` (numeric) to drop opened files into a specific pending CL; "
    + "omit or pass 'default' for the default CL. "
    + "Supports wildcard paths (e.g. '//depot/Foo/...') passed as single-element `files`.",
  {
    files: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Explicit depot or local file paths to open for edit. Wildcards (e.g. '//depot/Foo/...') "
          + "are supported. No workspace-wide default — caller must scope explicitly.",
      ),
    preview: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, run as dry-run with `-n` — files are NOT opened. "
          + "Defaults to false because the caller has explicitly named the files.",
      ),
    changelist: z
      .string()
      .optional()
      .describe(
        "Numeric pending CL to put opened files into. Omit (or pass 'default') for the default CL.",
      ),
  },
  async ({ files, preview, changelist }) => {
    let args;
    try {
      args = buildEditArgs({ files, changelist, preview });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
  },
);

server.tool(
  "p4_add",
  "Open new files for add to the depot (`p4 add`). "
    + "Required `files` — accepts explicit paths and wildcards (e.g. '//depot/Foo/...'). "
    + "preview=false (default) actually opens; set preview=true for a dry run (`-n`). "
    + "Use `filetype` to set the Perforce filetype on creation (e.g. 'binary+l' for "
    + "exclusively-locked binary assets, 'text+w' for always-writable text). "
    + "Use `changelist` (numeric) to drop opened files into a specific pending CL.",
  {
    files: z
      .array(z.string().min(1))
      .min(1)
      .describe("Explicit file paths to add. Wildcards supported (caller scopes)."),
    preview: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, run `p4 add -n` and do NOT open files."),
    changelist: z
      .string()
      .optional()
      .describe("Numeric pending CL. Omit or pass 'default' for the default CL."),
    filetype: z
      .string()
      .optional()
      .describe(
        "Perforce filetype (e.g. 'text', 'binary', 'binary+l', '+S2'). "
          + "Validated against an allowlist of base-type + modifier characters.",
      ),
  },
  async ({ files, preview, changelist, filetype }) => {
    let args;
    try {
      args = buildAddArgs({ files, changelist, preview, filetype });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
  },
);

server.tool(
  "p4_delete",
  "Mark depot files for delete (`p4 delete`). "
    + "Required `files` — caller must scope explicitly. "
    + "preview=true (default) runs `p4 delete -n` because delete is destructive of the depot file. "
    + "Set preview=false to actually mark for delete. "
    + "Use `keepWorkspaceFile=true` to mark for delete in the depot but keep the file on disk (`-k`). "
    + "Use `changelist` to drop the delete into a specific pending CL.",
  {
    files: z.array(z.string().min(1)).min(1).describe("Files to mark for delete."),
    preview: z.boolean().optional().default(true).describe("Dry-run default — delete is destructive of the depot file."),
    keepWorkspaceFile: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, pass `-k` to keep the workspace file after the delete is opened."),
    changelist: z.string().optional().describe("Numeric pending CL. Omit or 'default' for default CL."),
  },
  async ({ files, preview, keepWorkspaceFile, changelist }) => {
    let args;
    try {
      args = buildDeleteArgs({ files, changelist, preview, keepWorkspaceFile });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
  },
);

server.tool(
  "p4_revert",
  "Discard pending changes — close opened files without submitting (`p4 revert`). "
    + "Required `files` — no workspace-wide default; would discard every open in the workspace. "
    + "preview=true (default) runs `p4 revert -n` because revert DESTROYS in-progress work "
    + "(set preview=false to actually revert). "
    + "Use `keepWorkspaceFile=true` (`-k`) to close the open but keep your edits on disk — "
    + "the standard 'I opened this by mistake but want to keep my work' escape hatch. "
    + "Use `unchangedOnly=true` (`-a`) to revert only files that haven't actually been modified.",
  {
    files: z
      .array(z.string().min(1))
      .min(1)
      .describe("Files to revert. No workspace-wide default — must scope explicitly."),
    preview: z
      .boolean()
      .optional()
      .default(true)
      .describe("Dry-run default — revert is destructive of pending work."),
    keepWorkspaceFile: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, pass `-k`: close the open status but keep your edits on disk."),
    unchangedOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, pass `-a`: revert only files that haven't been modified."),
    changelist: z.string().optional().describe("Numeric pending CL to scope revert to. Omit or 'default' for default CL."),
  },
  async ({ files, preview, keepWorkspaceFile, unchangedOnly, changelist }) => {
    let args;
    try {
      args = buildRevertArgs({ files, changelist, preview, keepWorkspaceFile, unchangedOnly });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
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
        "Depot or local path to reconcile (e.g. '//YourDepot/Source/...'). "
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
  "p4_lock",
  "Acquire an exclusive lock on opened files (`p4 lock`). "
    + "Required for safe concurrent edits on binary assets (e.g. Unreal .uasset / .umap) — "
    + "without a lock, two devs opening the same binary file produces an unrecoverable conflict at submit. "
    + "Files must already be opened in this workspace; lock errors if they aren't. "
    + "Use `changelist` to scope the lock to a specific pending CL.",
  {
    files: z.array(z.string().min(1)).min(1).describe("Already-opened files to lock."),
    changelist: z.string().optional().describe("Numeric pending CL. Omit or 'default' for default CL."),
  },
  async ({ files, changelist }) => {
    let args;
    try {
      args = buildLockArgs({ files, changelist });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
  },
);

server.tool(
  "p4_unlock",
  "Release an exclusive lock on opened files (`p4 unlock`). "
    + "Only releases locks owned by this user — does not support `-f` (admin-only force-unlock); "
    + "use the `p4` CLI directly if you need to break someone else's lock.",
  {
    files: z.array(z.string().min(1)).min(1).describe("Files to unlock."),
    changelist: z.string().optional().describe("Numeric pending CL. Omit or 'default' for default CL."),
  },
  async ({ files, changelist }) => {
    let args;
    try {
      args = buildUnlockArgs({ files, changelist });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 60000 }));
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

server.tool(
  "p4_shelve",
  "Shelve files from a pending changelist (`p4 shelve`). "
    + "Stores a copy of the open files on the server without submitting. "
    + "Required `changelist` (must be numeric — cannot shelve the default CL). "
    + "Pass `files` to shelve a subset; omit to shelve everything in the CL. "
    + "Set `replace=true` to overwrite an existing shelf with the current open files (passes `-r -f`).",
  {
    changelist: z.string().min(1).describe("Numeric pending CL to shelve from."),
    files: z.array(z.string().min(1)).optional().describe("Optional subset of files to shelve."),
    replace: z.boolean().optional().default(false).describe("If true, overwrite existing shelf (`-r -f`)."),
  },
  async ({ changelist, files, replace }) => {
    let args;
    try {
      args = buildShelveArgs({ changelist, files, replace });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 120000 }));
  },
);

server.tool(
  "p4_unshelve",
  "Bring shelved files into the workspace (`p4 unshelve`). "
    + "Reads from `sourceChangelist` (the shelf) and opens the files in this workspace. "
    + "By default opens in the default CL; pass `targetChangelist` to route into a specific pending CL. "
    + "Pass `files` to unshelve a subset.",
  {
    sourceChangelist: z.string().min(1).describe("Numeric CL containing the shelved files."),
    targetChangelist: z.string().optional().describe("Numeric pending CL to open files in. Omit/'default' for default CL."),
    files: z.array(z.string().min(1)).optional().describe("Optional subset of files to unshelve."),
    preview: z.boolean().optional().default(false).describe("If true, run `p4 unshelve -n` for a dry run."),
  },
  async ({ sourceChangelist, targetChangelist, files, preview }) => {
    let args;
    try {
      args = buildUnshelveArgs({ sourceChangelist, targetChangelist, files, preview });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 120000 }));
  },
);

server.tool(
  "p4_integrate",
  "Set up branch integration between two depot paths (`p4 integrate`). "
    + "preview=true (default) runs `p4 integrate -n` because integrations can fan out across many files via wildcards. "
    + "Pass `force=true` (`-f`) to force integration of revisions already integrated. "
    + "Pass `reverse=true` (`-r`) to swap source and target. "
    + "For merge-biased semantics use `p4_merge`; for byte-identical replacement use `p4_copy`.",
  {
    source: z.string().min(1).describe("Source depot path (may include revision spec like #5 or @CL)."),
    target: z.string().min(1).describe("Target depot path."),
    preview: z.boolean().optional().default(true).describe("Dry-run default — integrate can scoop many files via wildcards."),
    changelist: z.string().optional().describe("Numeric pending CL. Omit or 'default' for default CL."),
    force: z.boolean().optional().default(false).describe("If true, pass `-f`: force integration of already-integrated revisions."),
    reverse: z.boolean().optional().default(false).describe("If true, pass `-r`: reverse source and target."),
  },
  async ({ source, target, preview, changelist, force, reverse }) => {
    let args;
    try {
      args = buildIntegrateArgs({ source, target, changelist, preview, force, reverse });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 120000 }));
  },
);

server.tool(
  "p4_merge",
  "Merge changes between two depot paths (`p4 merge`). "
    + "Friendlier `p4 integrate` with merge-biased defaults — appropriate for general dev branch syncing. "
    + "preview=true (default) runs `p4 merge -n` (same wildcard-fanout reasoning as integrate). "
    + "Pass `force=true` (`-F`, capital — distinct from integrate's `-f`) to force merge of already-merged revisions. "
    + "Pass `reverse=true` (`-r`) to swap source and target.",
  {
    source: z.string().min(1).describe("Source depot path (may include revision spec)."),
    target: z.string().min(1).describe("Target depot path."),
    preview: z.boolean().optional().default(true).describe("Dry-run default."),
    changelist: z.string().optional().describe("Numeric pending CL. Omit or 'default' for default CL."),
    force: z.boolean().optional().default(false).describe("If true, pass `-F` (capital): force merge of already-merged revisions."),
    reverse: z.boolean().optional().default(false).describe("If true, pass `-r`: reverse source and target."),
  },
  async ({ source, target, preview, changelist, force, reverse }) => {
    let args;
    try {
      args = buildMergeArgs({ source, target, changelist, preview, force, reverse });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 120000 }));
  },
);

server.tool(
  "p4_copy",
  "Stamp source onto target verbatim — no content merging (`p4 copy`). "
    + "Used for release-promotion / branch-sync flows where target should become a byte-identical copy of source. "
    + "preview=true (default) runs `p4 copy -n`. "
    + "Pass `force=true` (`-F`, capital) to copy outside the normal simple-copy condition. "
    + "Pass `reverse=true` (`-r`) to swap source and target. "
    + "Unlike `p4_merge`, copy never produces conflicts — it overwrites.",
  {
    source: z.string().min(1).describe("Source depot path."),
    target: z.string().min(1).describe("Target depot path (will be overwritten)."),
    preview: z.boolean().optional().default(true).describe("Dry-run default."),
    changelist: z.string().optional().describe("Numeric pending CL. Omit or 'default' for default CL."),
    force: z.boolean().optional().default(false).describe("If true, pass `-F` (capital): force copy outside normal conditions."),
    reverse: z.boolean().optional().default(false).describe("If true, pass `-r`: reverse source and target."),
  },
  async ({ source, target, preview, changelist, force, reverse }) => {
    let args;
    try {
      args = buildCopyArgs({ source, target, changelist, preview, force, reverse });
    } catch (e) {
      return toolErrorResult(e.message);
    }
    return toolResult(p4(args, { timeout: 120000 }));
  },
);

// ───────────────────────────────────────────────────────────────────────
// Admin / identity tier (WRITE) — opt-in via P4_ENABLE_ADMIN. These mutate
// server-global state and require `super`. Each writer first runs a capability
// pre-check so a non-super caller gets a clear, structured error instead of a
// raw p4 permission failure mid-mutation.
// ───────────────────────────────────────────────────────────────────────

// Returns { ok: true, level } when the connected user has `super`, else
// { ok: false, ... } describing why. Used to gate global-mutation tools.
function requireSuper() {
  const result = p4(buildProtectsArgs({ max: true }));
  if (!result.ok) {
    return { ok: false, reason: "protects-failed", detail: result.output };
  }
  const level = parseProtectsMax(result.output);
  if (level !== "super") {
    return { ok: false, reason: "insufficient", level };
  }
  return { ok: true, level };
}

if (ADMIN_WRITES_ENABLED) {
  server.tool(
    "p4_group_set",
    "Create or modify a Perforce group spec (`p4 group -i`). Server-global write; "
      + "requires `super` access (pre-checked). Reads the current spec, changes only "
      + "the fields you pass, and writes it back — other fields (MaxResults, "
      + "MaxScanRows, MaxLockTime, etc.) are preserved. `timeout` accepts 'unlimited', "
      + "'unset', or a positive integer of seconds. `users`/`owners`/`subgroups`, when "
      + "given, REPLACE that section's entire membership. Defaults to preview (`-o` "
      + "read-back of the would-be spec) — set preview:false to apply.",
    {
      group: z.string().min(1).describe("Group name to create or modify."),
      timeout: z
        .string()
        .optional()
        .describe("Ticket lifetime: 'unlimited', 'unset', or positive integer seconds (e.g. '1209600' = 2 weeks)."),
      users: z.array(z.string()).optional().describe("Replace the group's Users list with exactly these."),
      owners: z.array(z.string()).optional().describe("Replace the group's Owners list with exactly these."),
      subgroups: z.array(z.string()).optional().describe("Replace the group's Subgroups list with exactly these."),
      preview: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview the resulting spec without writing (default true). Set false to apply."),
    },
    async ({ group, timeout, users, owners, subgroups, preview }) => {
      if (timeout === undefined && users === undefined && owners === undefined && subgroups === undefined) {
        return toolErrorResult("Nothing to change: provide at least one of timeout, users, owners, subgroups.");
      }
      const cap = requireSuper();
      if (!cap.ok) {
        if (cap.reason === "insufficient") {
          return toolErrorResult(
            `p4_group_set requires 'super' access; your effective level is '${cap.level ?? "unknown"}'. `
              + "Ask a Perforce admin to make this change.",
          );
        }
        return toolErrorResult(`Could not verify access level (p4 protects -m failed): ${cap.detail}`);
      }

      // Read the current spec (or a fresh template for a new group), apply the
      // requested changes to that text, and either preview or pipe it back.
      const read = p4(buildGroupInfoArgs({ group }));
      if (!read.ok) return toolErrorResult(read.output);

      let updatedSpec;
      try {
        updatedSpec = applyGroupSpecChanges(read.output, { timeout, users, owners, subgroups });
      } catch (e) {
        return toolErrorResult(e.message);
      }

      if (preview) {
        return toolJsonResult({
          scope: "server-global",
          preview: true,
          group,
          spec: updatedSpec,
          note: "Preview only — no change written. Set preview:false to apply.",
        });
      }

      const write = p4(["group", "-i"], { input: updatedSpec });
      if (!write.ok) return toolErrorResult(write.output);
      return toolJsonResult({ scope: "server-global", preview: false, group, result: write.output });
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[perforce-bridge] running ${P4USER}@${P4PORT} client=${P4CLIENT} depot=//${P4DEPOT}/...`
    + ` adminWrites=${ADMIN_WRITES_ENABLED ? "on" : "off"}`,
);
