import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

import { toolJsonResult } from "../../lib/tool-result.mjs";
import { discoverTargets, formatTargets, sendMessage } from "./client.mjs";
import { resolveCallerIdentity } from "./identity.mjs";
import { inventory, queryFleet } from "./fleet.mjs";

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


const server = new McpServer({ name: "relay-bridge", version: "0.1.0" });

server.tool(
  "relay_list",
  "List live Claude Code and Codex sessions locally or across configured hosts.",
  {
    scope: z
      .enum(["cwd", "all"])
      .optional()
      .describe("cwd (default) lists sessions sharing the caller's workspace tree; all lists every session on the machine"),
    cwd: z.string().optional().describe("Workspace to scope to. Defaults to the server's working directory."),
    all_hosts: z.boolean().optional().describe("Query the configured hosts concurrently. An explicit workspace scope applies on this host."),
  },
  // Reads two machine-local registries and nothing else. Declared read-only so
  // a host can auto-approve it: measured from a real Codex session, a tool with
  // no readOnlyHint is treated as side-effecting, and under
  // `approval_policy = "never"` the call fails outright rather than prompting.
  { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  async ({ scope, cwd, all_hosts = false }, extra) => {
    if (all_hosts) {
      try {
        return toolJsonResult(await queryFleet("inventory", {
          localInventory: () => inventory({ scope: scope || "all", cwd: cwd || process.cwd() }),
        }));
      } catch {
        return toolJsonResult({ ok: false, cause: "directory_unavailable" });
      }
    }
    scope ??= "cwd";
    const result = await discoverTargets({ scope, cwd: cwd || process.cwd() });
    // Resolved per call like the send path, so a caller asking who it is gets
    // the same answer relay would stamp on its next message.
    const identity = resolveCallerIdentity({ extra });
    return toolJsonResult({
      targets: result.targets,
      warnings: result.warnings,
      rendered: formatTargets(result),
      // A listing is a snapshot: both registries turn over in minutes, and a
      // target can exit between this call and a send.
      note: "Live snapshot. Re-list before acting on it; sessions come and go within minutes.",
      callerIdentity: identity
        ? {
            verified: true,
            id: identity.id,
            provider: identity.provider,
            source:
              identity.channel === "request-metadata"
                ? "metadata the host attached to this call"
                : "host session environment",
          }
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
    conversation: z
      .string()
      .optional()
      .describe("Continue this conversation, quoted from a relay header. Minted if omitted."),
    kind: z
      .enum(["request", "reply", "notice"])
      .optional()
      .describe(
        "request expects an answer; reply answers one; notice expects nothing. Informational: relay records it and does not enforce it.",
      ),
    in_reply_to: z
      .string()
      .optional()
      .describe("The message id being answered, quoted from a relay header."),
  },
  // NOT read-only: it queues a message into another agent's session. Claiming
  // otherwise to dodge an approval prompt would be a lie told to the host's
  // safety layer. It is non-destructive — it adds a message, removes nothing.
  { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  async ({ to, message, dry_run = false, from, conversation, kind, in_reply_to }, extra) => {
    const result = await sendMessage({
      to,
      message,
      dryRun: dry_run,
      // The delegate exists on this side of the sandbox boundary and nowhere
      // else, which is the reason this face exists at all.
      allowDelegate: true,
      origin: from,
      // Resolved per call, from the request rather than the arguments. `extra`
      // carries the metadata the host attached; the arguments object is never
      // consulted, and a caller passing a counterfeit `_meta` there is ignored.
      identity: resolveCallerIdentity({ extra }),
      conversation,
      kind,
      inReplyTo: in_reply_to,
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
