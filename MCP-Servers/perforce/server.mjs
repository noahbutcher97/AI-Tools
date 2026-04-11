import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "child_process";

// All project-specific config comes from env vars in .mcp.json
const P4PORT = process.env.P4PORT;
const P4USER = process.env.P4USER;
const P4CLIENT = process.env.P4CLIENT;
const P4DEPOT = process.env.P4DEPOT; // e.g. "Project1/OnSight"

if (!P4PORT || !P4USER || !P4CLIENT || !P4DEPOT) {
  console.error("Missing required env vars: P4PORT, P4USER, P4CLIENT, P4DEPOT");
  process.exit(1);
}

const P4_BASE_ARGS = ["-p", P4PORT, "-u", P4USER, "-c", P4CLIENT];
const DEPOT_ROOT = `//${P4DEPOT}/...`;

// ── Auto-login if P4PASSWD is set ──
// Modern P4 servers (security level >= 3) require a ticket from `p4 login`
// rather than accepting P4PASSWD as an env var. We pipe the password to stdin.
const P4PASSWD = process.env.P4PASSWD;
if (P4PASSWD) {
  try {
    execFileSync("p4", [...P4_BASE_ARGS, "login"], {
      input: P4PASSWD + "\n",
      encoding: "utf-8",
      timeout: 15000,
    });
    console.error(`[perforce] Logged in as ${P4USER} @ ${P4PORT}`);
  } catch (err) {
    // Login may fail if server uses security level < 3 (password auth works
    // directly via env var) or if the ticket is already cached. Either way,
    // we proceed — tool calls will surface the real error if auth is broken.
    console.error(`[perforce] Login attempt: ${(err.stderr || err.message).trim()}`);
  }
}

function p4(cmdArgs, opts = {}) {
  const timeout = opts.timeout || 30000;
  try {
    const result = execFileSync("p4", [...P4_BASE_ARGS, ...cmdArgs], {
      encoding: "utf-8",
      timeout,
      maxBuffer: 1024 * 1024 * 5,
    });
    return result.trim();
  } catch (err) {
    return `ERROR: ${err.stderr || err.message}`;
  }
}

const server = new Server(
  { name: "mcp-perforce", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "p4_opened",
      description:
        "List files currently opened for edit/add/delete in the workspace. Shows what you have checked out.",
      inputSchema: {
        type: "object",
        properties: {
          changelist: {
            type: "string",
            description: "Optional changelist number to filter by",
          },
        },
      },
    },
    {
      name: "p4_changes",
      description:
        "List recent submitted changelists. Defaults to last 10 by current user.",
      inputSchema: {
        type: "object",
        properties: {
          max: {
            type: "number",
            description: "Max changelists to return (default 10)",
          },
          user: {
            type: "string",
            description: `Filter by user (default: ${P4USER})`,
          },
          status: {
            type: "string",
            enum: ["submitted", "pending"],
            description: "Filter by status (default: submitted)",
          },
        },
      },
    },
    {
      name: "p4_describe",
      description:
        "Show full details of a changelist — description, affected files, and diffs for text files.",
      inputSchema: {
        type: "object",
        properties: {
          changelist: {
            type: "string",
            description: "Changelist number to describe",
          },
          summary_only: {
            type: "boolean",
            description:
              "If true, show only description and file list (no diffs). Default false.",
          },
        },
        required: ["changelist"],
      },
    },
    {
      name: "p4_diff",
      description:
        "Show diffs for opened files. Can filter to a specific file or path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              `Optional depot or local path to diff (e.g., "//${P4DEPOT}/Source/...")`,
          },
        },
      },
    },
    {
      name: "p4_filelog",
      description: "Show revision history for a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Depot or local file path",
          },
          max: {
            type: "number",
            description: "Max revisions to show (default 5)",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "p4_reconcile_preview",
      description:
        "Preview what reconcile would find (offline adds/edits/deletes) without actually opening files. Dry run only.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              `Path to reconcile (default: "//${P4DEPOT}/Source/...")`,
          },
        },
      },
    },
    {
      name: "p4_fstat",
      description:
        "Show detailed file status — depot path, local path, action, head revision, etc.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File or path to stat",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "p4_changelists",
      description: "List pending changelists in the workspace.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "p4_sync",
      description:
        "Sync files from the depot. Can sync entire depot or a specific path.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              `Depot path to sync (default: "${DEPOT_ROOT}")`,
          },
        },
      },
    },
    {
      name: "p4_resolve",
      description:
        "Resolve files after sync. Use mode to control resolution strategy.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File or path to resolve",
          },
          mode: {
            type: "string",
            enum: ["am", "at", "ay"],
            description:
              "Resolution mode: am=auto-merge, at=accept theirs, ay=accept yours",
          },
        },
        required: ["mode"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "p4_opened": {
      const cmdArgs = ["opened"];
      if (args?.changelist) cmdArgs.push("-c", String(args.changelist));
      return text(p4(cmdArgs));
    }

    case "p4_changes": {
      const max = String(args?.max || 10);
      const user = args?.user || P4USER;
      const status = args?.status || "submitted";
      return text(
        p4(["changes", "-s", status, "-u", user, "-m", max, DEPOT_ROOT])
      );
    }

    case "p4_describe": {
      const cmdArgs = ["describe"];
      if (args?.summary_only) cmdArgs.push("-s");
      cmdArgs.push(String(args.changelist));
      return text(p4(cmdArgs, { timeout: 60000 }));
    }

    case "p4_diff": {
      const cmdArgs = ["diff"];
      if (args?.path) cmdArgs.push(args.path);
      return text(p4(cmdArgs, { timeout: 60000 }));
    }

    case "p4_filelog": {
      const max = String(args?.max || 5);
      return text(p4(["filelog", "-m", max, args.path]));
    }

    case "p4_reconcile_preview": {
      const path = args?.path || `//${P4DEPOT}/Source/...`;
      return text(p4(["reconcile", "-n", path], { timeout: 60000 }));
    }

    case "p4_fstat": {
      return text(p4(["fstat", args.path]));
    }

    case "p4_changelists": {
      return text(
        p4(["changes", "-s", "pending", "-c", P4CLIENT, DEPOT_ROOT])
      );
    }

    case "p4_sync": {
      const path = args?.path || DEPOT_ROOT;
      return text(p4(["sync", path], { timeout: 120000 }));
    }

    case "p4_resolve": {
      const cmdArgs = ["resolve", `-${args.mode}`];
      if (args?.path) cmdArgs.push(args.path);
      return text(p4(cmdArgs, { timeout: 60000 }));
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
});

function text(content) {
  return { content: [{ type: "text", text: content }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[perforce] MCP server running — ${P4USER}@${P4PORT} client=${P4CLIENT} depot=//${P4DEPOT}/...`);
