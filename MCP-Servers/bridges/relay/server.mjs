import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

import { toolJsonResult } from "../../lib/tool-result.mjs";
import { detectVerifiedOrigin, discoverTargets, formatTargets, sendMessage } from "./client.mjs";

// Cross-agent relay — MCP face (spec 4.1, 4.4).
//
// This is the sandbox crossing. Codex spawns MCP servers from its parent
// process rather than through the command sandbox, which is why the existing
// bridges reach the network from Codex at all (spec 3.4). The `claude -p`
// delegate therefore lives on this side of the boundary and nowhere else:
// `allowDelegate` is true here and false in the CLI unless asked for.
//
// It is also the preferred face for both agents because message payloads are
// multi-line prose, and shell quoting corrupts exactly that.

// node:sqlite is experimental and announces itself on stderr. The MCP protocol
// owns stdout so this is harmless to the transport, but it makes bridge logs
// noisier for no reason.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
  console.error(`${warning.name}: ${warning.message}`);
});

// Authenticated caller identity, where the host provides one. An agent cannot
// set the environment of the server it is talking to, so a value read from here
// identifies the calling session in a way a `from` tool argument never can.
//
// This works for Claude, which sets CLAUDE_CODE_SESSION_ID in the environment
// of servers it spawns. It does NOT work for Codex, measured 2026-08-26 by
// reading the environment blocks of the running servers: Codex spawns MCP
// servers with a scrubbed environment of 18 variables carrying no thread or
// session id, while servers spawned by Claude carry 74 including a live id. One
// Codex server was spawned in the same second as its thread, so the id is
// absent rather than stale, and no per-call re-read would recover it.
//
// Codex supplies the same information by another route, measured the same day:
// every tool call carries `_meta["x-codex-turn-metadata"]` with `thread_id`,
// `session_id` and `turn_id`, plus a top-level `_meta.threadId`. That channel is
// injected by the Codex MCP client after the caller's arguments - an agent
// passing a forged `_meta` in its tool arguments was measured and the real ids
// arrived unchanged - so it carries the same non-forgeability this env read
// relies on, and being per-call it cannot go stale the way a startup read can.
//
// Until the handlers read that metadata, messages relayed from Codex arrive with
// no verified origin and no reply address. Do not "fix" that by trusting the
// `from` argument, which is exactly what it cannot be.
// Read once at startup, because the server is spawned per session.
const HOST_IDENTITY = detectVerifiedOrigin();

const server = new McpServer({ name: "relay-bridge", version: "0.1.0" });

server.tool(
  "relay_list",
  "List the live Claude Code and Codex agent sessions on this machine, with status, idle time, workspace and whether each can be sent to.",
  {
    scope: z
      .enum(["cwd", "all"])
      .optional()
      .describe("cwd (default) lists sessions sharing the caller's workspace tree; all lists every session on the machine"),
    cwd: z.string().optional().describe("Workspace to scope to. Defaults to the server's working directory."),
  },
  // Reads two machine-local registries and nothing else. Declared read-only so
  // a host can auto-approve it: measured from a real Codex session, a tool with
  // no readOnlyHint is treated as side-effecting, and under
  // `approval_policy = "never"` the call fails outright rather than prompting.
  { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async ({ scope = "cwd", cwd }) => {
    const result = await discoverTargets({ scope, cwd: cwd || process.cwd() });
    return toolJsonResult({
      targets: result.targets,
      warnings: result.warnings,
      rendered: formatTargets(result),
      // A listing is a snapshot: both registries turn over in minutes, and a
      // target can exit between this call and a send.
      note: "Live snapshot. Re-list before acting on it; sessions come and go within minutes.",
      callerIdentity: HOST_IDENTITY
        ? { verified: true, id: HOST_IDENTITY.id, provider: HOST_IDENTITY.provider, source: "host session environment" }
        : { verified: false, id: null, source: "unavailable; messages will carry a claimed origin only" },
    });
  },
);

server.tool(
  "relay_send",
  "Send a message to another agent session. Codex targets are queued directly; Claude targets are relayed by a confined delegate that may use no tool but SendMessage.",
  {
    to: z.string().describe("Target name (Claude session name) or Codex thread id, as reported by relay_list"),
    message: z.string().min(1).describe("Message body. Multi-line prose is preserved."),
    dry_run: z
      .boolean()
      .optional()
      .describe("Resolve and check the target without delivering anything"),
    from: z
      .string()
      .optional()
      .describe(
        "Who to say this is from. Relay cannot authenticate it, so it is delivered marked as an unverified claim. The delegate's own session name is ephemeral and cannot be replied to.",
      ),
  },
  // NOT read-only: it queues a message into another agent's session. Claiming
  // otherwise to dodge an approval prompt would be a lie told to the host's
  // safety layer. It is non-destructive — it adds a message, removes nothing.
  { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  async ({ to, message, dry_run = false, from }) => {
    const result = await sendMessage({
      to,
      message,
      dryRun: dry_run,
      // The delegate exists on this side of the sandbox boundary and nowhere
      // else, which is the reason this face exists at all.
      allowDelegate: true,
      origin: from,
      // Never taken from a tool argument.
      verifiedOrigin: HOST_IDENTITY?.id ?? null,
      verifiedProvider: HOST_IDENTITY?.provider ?? null,
      // RELAY_SPOOL relocates the failure spool. The registration tests set it
      // so a test run cannot append to the operator's real spool.
      ...(process.env.RELAY_SPOOL ? { spoolPath: process.env.RELAY_SPOOL } : {}),
    });
    return toolJsonResult(result);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[relay-bridge] ready");
