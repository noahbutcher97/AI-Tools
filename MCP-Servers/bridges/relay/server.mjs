import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

import { toolJsonResult } from "../../lib/tool-result.mjs";
import { formatTargets } from "./client.mjs";
import { listInstalledTargets } from "./local-address.mjs";
import { resolveAddress } from "./resolve-address.mjs";
import { pingTarget, sendAddressed, sendStatus } from "./addressed-send.mjs";
import { pingBound, sendBound } from "./installed-delivery.mjs";
import { resolveCallerIdentity } from "./identity.mjs";
import { inventory, queryFleet } from "./fleet.mjs";
import { fleetReadiness, loadedBuild, readReadiness } from "./readiness.mjs";

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
  "relay_watch",
  "Activate an owner-granted schedule, file or branch watch for the calling Codex thread.",
  { target: z.string().uuid(), condition: z.string().uuid() },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ target, condition }, extra) => {
    const { subscribeWatch } = await import("./watch-client.mjs");
    return toolJsonResult(await subscribeWatch(target, condition, resolveCallerIdentity({ extra })));
  },
);

server.tool(
  "relay_list",
  "List sessions from local inventory adapters or query the configured hosts. Local results report whether each adapter enumerated its sessions. Workspace and activity details can still be unknown. For partial remote inventory, use relay_send with dry_run to check current target eligibility.",
  {
    scope: z
      .enum(["cwd", "all"])
      .optional()
      .describe("cwd (default) lists sessions sharing the caller's workspace tree; all lists every session on the machine"),
    cwd: z.string().optional().describe("Workspace to scope to. Defaults to the server's working directory."),
    all_hosts: z.boolean().optional().describe("Query the configured hosts concurrently. An explicit workspace scope applies on this host."),
  },
  // Local discovery reads inventory from the configured adapters. Declared read-only so
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
    const result = await listInstalledTargets({ scope, cwd: cwd || process.cwd() });
    // Resolved per call like the send path, so a caller asking who it is gets
    // the same answer relay would stamp on its next message.
    const identity = resolveCallerIdentity({ extra });
    return toolJsonResult({
      targets: result.targets,
      warnings: result.warnings,
      complete: result.complete,
      inventory: result.inventory,
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

const selectorFields = {
  id: z.string().min(1).describe("Case-sensitive, literal native session ID. Colons, slashes and leading dashes are part of the ID."),
  adapter: z.string().min(1).optional().describe("With id, select the installed adapter shown as kind in relay_list."),
  host: z.string().min(1).optional().describe("With id, check the canonical label of this local machine."),
};

server.registerTool("relay_resolve", {
  description: "Look up an exact session ID without waking it. Omit host for local lookup or supply one enrolled host with lookup permission for the ID. Use the reader's kind as adapter to narrow an ambiguous or incomplete lookup.",
  inputSchema: z.object({ ...selectorFields,
    host: z.string().min(1).optional().describe("Canonical host label, supplied separately from the literal ID. Omit to search locally."),
  }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async selector => {
  const result = await resolveAddress(selector);
  return { ...toolJsonResult(result), isError: !result.ok };
});

server.registerTool("relay_send", {
  description: "Send a message using either to or an exact local id. Use dry_run to check eligibility. A queue acknowledgment confirms submission.",
  inputSchema: z.object({
    ...selectorFields,
    id: selectorFields.id.optional(),
    to: z.string().min(1).optional().describe("Local session ID or Claude name, or host:id on a configured machine. Use this or id."),
    request_id: z.string().optional().describe("A UUIDv7 for a retryable cross-host send."),
    re: z.string().optional().describe("Quote a bounded excerpt from this turn in the target session."),
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
  }).strict(),
  // NOT read-only: it queues a message into another agent's session. Claiming
  // otherwise to dodge an approval prompt would be a lie told to the host's
  // safety layer. It is non-destructive — it adds a message, removes nothing.
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ to, id, adapter, host, message, dry_run = false, from, conversation, kind, in_reply_to, request_id, re }, extra) => {
  if ((id === undefined) === (to === undefined) || (id === undefined && (adapter !== undefined || host !== undefined)) ||
      (id !== undefined && request_id !== undefined)) {
    return { ...toolJsonResult({ ok: false, cause: "invalid_send_mode", detail: "Use either to or id. Only id accepts adapter and host. A request_id requires a remote to address." }), isError: true };
  }
  const options = {
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
    re,
  };
  if (id !== undefined) {
    const result = await sendBound({ id, adapter, host }, options);
    return { ...toolJsonResult(result), isError: !result.ok };
  }
  return toolJsonResult(await sendAddressed({ ...options, to, requestId: request_id }));
});

server.registerTool("relay_ping", {
  description: "Wake one target with a delivery probe using target or an exact local id. Check a returned receipt with status without waking the session again. Use all_hosts for fleet reachability.",
  inputSchema: z.object({
    ...selectorFields,
    id: selectorFields.id.optional(),
    all_hosts: z.literal(true).optional(),
    status: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ all_hosts, status, target, id, adapter, host }) => {
  if ([all_hosts, status, target, id].filter(value => value !== undefined).length !== 1 ||
      (id === undefined && (adapter !== undefined || host !== undefined))) {
    return { ...toolJsonResult({ ok: false, cause: "invalid_ping_mode", detail: "Use one of target, id, status or all_hosts. Only id accepts adapter and host." }), isError: true };
  }
  if (id !== undefined) {
    const result = await pingBound({ id, adapter, host }, { allowDelegate: true });
    return { ...toolJsonResult(result), isError: !result.ok };
  }
  try {
    if (target) return toolJsonResult(await pingTarget(target, { allowDelegate: true }));
    return toolJsonResult(status ? await sendStatus(status) : await queryFleet("probe"));
  }
  catch { return toolJsonResult({ ok: false, cause: "directory_unavailable" }); }
});

const transport = new StdioServerTransport();
server.tool(
  "relay_doctor",
  "Read the dated readiness record from the latest CLI doctor run, locally or across configured hosts.",
  { all_hosts: z.boolean().optional() },
  { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  async ({ all_hosts }) => {
    const record = readReadiness();
    try {
      if (all_hosts) return toolJsonResult(await fleetReadiness({ local: record }));
      const status = !record ? "no_readiness" : record.build !== loadedBuild ? "build_mismatch" :
        Date.now() > Date.parse(record.validUntil) ? "stale" : record.status;
      return toolJsonResult({ status, record });
    } catch { return toolJsonResult({ ok: false, cause: "directory_unavailable" }); }
  },
);
await server.connect(transport);
console.error("[relay-bridge] ready");
