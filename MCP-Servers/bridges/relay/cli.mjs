#!/usr/bin/env node
// Cross-agent relay — CLI face (spec 4.1).
//
// Mandatory alongside the MCP face: this is the hand-debugging path, and the
// escape hatch when the MCP server is not loaded in a given session.
//
//   node cli.mjs list                     sessions sharing this workspace
//   node cli.mjs list --scope all         every agent session on this machine
//   node cli.mjs list --cwd D:/some/path  scope to a workspace you are not in
//   node cli.mjs list --json              machine-readable
//
//   node cli.mjs send <thread-id> --message "text"
//   ... | node cli.mjs send <thread-id>   message on stdin, for multi-line prose
//   node cli.mjs send <thread-id> --dry-run   resolve the target, queue nothing
//
// The CLI requires --via-delegate for Claude delivery.

import { formatTargets, parseArgs } from "./client.mjs";
import { listInstalledTargets, resolveLocalAddress } from "./local-address.mjs";
import { pingTarget, sendAddressed, sendStatus } from "./addressed-send.mjs";
import { pingBound, sendBound } from "./installed-delivery.mjs";
import { dispatchRemote } from "./remote-delivery.mjs";
import { checkReadiness, fleetReadiness, loadedBuild, readReadiness } from "./readiness.mjs";
import { resolveCallerIdentity } from "./identity.mjs";
import { receive } from "./receive.mjs";
import { inventory, queryFleet } from "./fleet.mjs";

const help = `Usage: relay <command> [options]

  list                         List sessions in the current workspace
  list --scope all             List sessions in all local workspaces
  list --json                  Show raw session IDs and coverage for each local reader
  list --all-hosts             List sessions on enrolled machines
  resolve --id LITERAL [--adapter KEY] [--host LABEL] [--json]
                               Look up an exact local session ID without waking it
  send <target> --message TEXT Send a notice; --dry-run previews the destination
  send --id LITERAL            Send to an exact local session (see send --help)
  ping <target>                Wake the session once and check for delivery
  ping --id LITERAL            Probe an exact local session (see ping --help)
  ping --status <receipt>      Check the existing receipt without waking it again
  doctor                       Check readiness; --all-hosts includes peers
  watch --notify <id> <condition-id>  Activate an approved watch
  run -- <command> [args...]   Run an approved job with completion notification

Use the host-qualified ID shown by list --all-hosts for a remote session.
A queue receipt confirms acceptance. A delivered probe confirms arrival.`;

const resolveHelp = `Usage: relay resolve --id LITERAL [--adapter KEY] [--host LABEL] [--json]

Copy the case-sensitive id from relay list --scope all --json. Keep any colon
or slash inside the ID. For an ID beginning with -- use --id=VALUE.
Use the row's kind as --adapter to narrow the lookup to one installed reader.
The optional --host must identify this machine. Resolution only reads inventory.`;

const literalTargetHelp = `Copy the case-sensitive id from relay list --scope all --json. For a leading
double dash use --id=VALUE. If multiple adapters match, pass the row's kind as
--adapter KEY. The optional --host LABEL must name this machine. Exact local
delivery requires an adapter that can submit to that ID. The legacy Claude
target form uses --via-delegate.`;

const sendHelp = `Usage: relay send <target> | --id LITERAL [--adapter KEY] [--host LABEL]
  --message TEXT or piped stdin supplies the message. Use --dry-run to check
  eligibility first. --kind, --from, --re, --conversation and --in-reply-to
  carry message metadata. --json prints the full result.
  For remote delivery use a host:id target. --request-id applies to remote sends.

${literalTargetHelp}`;

const pingHelp = `Usage: relay ping <target> | --id LITERAL [--adapter KEY] [--host LABEL]
  ping wakes one session. --json writes one result to stdout. An early
  receipt on stderr lets you check status if the command is interrupted.
  relay ping --status RECEIPT checks an existing probe without another wake.
  relay ping --all-hosts checks fleet reachability.

${literalTargetHelp}`;

// node:sqlite is experimental and announces itself on every load. The warning
// is noise here and would be noise in a bridge log, so it is filtered while
// every other warning still prints.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
  console.error(`${warning.name}: ${warning.message}`);
});

async function main() {
  if (process.argv[2] === "receive") {
    const result = await receive(process.argv.slice(3), process.env.SSH_ORIGINAL_COMMAND, process.stdin, 3000, inventory, dispatchRemote,
      () => ({ record: readReadiness(), build: loadedBuild }));
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const args = process.argv.slice(2);
  const commandHelp = { resolve: resolveHelp, send: sendHelp, ping: pingHelp };
  if (args.length === 2 && Object.hasOwn(commandHelp, args[0]) && ["-h", "--help"].includes(args[1])) {
    console.log(commandHelp[args[0]]);
    return;
  }
  if (args.length === 1 && ["help", "-h", "--help"].includes(args[0]) ||
      args.length === 2 && ["list","doctor","watch","run"].includes(args[0]) &&
      ["-h","--help"].includes(args[1])) {
    console.log(help);
    return;
  }
  let options;
  try {
    options = parseArgs(args);
  } catch (err) {
    console.error(`relay: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  if (options.command === "resolve") {
    const result = await resolveLocalAddress(options.selector);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(`Resolved local session ${JSON.stringify(result.target)}`);
    else {
      console.error(`${result.state}: ${result.detail}`);
      if (result.adapters?.length) console.error(`Adapters: ${JSON.stringify(result.adapters)}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (options.command === "watch") {
    const { subscribeWatch } = await import("./watch-client.mjs");
    const result = await subscribeWatch(options.to, options.condition, resolveCallerIdentity());
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (options.command === "run") {
    const { startRun, RunInputError } = await import("./run-job.mjs");
    try {
      const result = await startRun(options.argv, resolveCallerIdentity(), process.stdin);
      console.log(JSON.stringify(result));
      process.exitCode = result.state === "started" ? 0 : 1;
    } catch (error) {
      if (!(error instanceof RunInputError)) throw error;
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }
  if (options.command === "send") {
    await runSend(options);
    return;
  }
  if (options.command === "doctor") {
    const local = await checkReadiness({ target: options.probeTarget });
    const report = options.allHosts ? await fleetReadiness({ local, persist: true }) : local;
    console.log(JSON.stringify(report, null, options.json ? 2 : 0));
    process.exitCode = (options.allHosts ? report.ready : local.status === "ready") ? 0 : 3;
    return;
  }
  if (options.command === "ping" && !options.allHosts) {
    const hooks = { allowDelegate: options.viaDelegate, onHandle: printReceipt };
    let result;
    if (options.statusHandle) result = await sendStatus(options.statusHandle);
    else if (options.selector) result = await pingBound(options.selector, hooks);
    else result = await pingTarget(options.to, hooks);
    console.log(options.json ? JSON.stringify(result) : result.detail ?? result.state ?? result.cause);
    if (!options.json && !result.ok && result.handle && !result.detail?.includes("ping --status")) {
      console.error("Check the receipt without another wake: relay ping --status " + result.handle);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (options.allHosts) {
    const result = await queryFleet(options.command === "list" ? "inventory" : "probe", {
      localInventory: () => inventory({ scope: options.explicitScope || "all", cwd: options.cwd || process.cwd() }),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else for (const row of result.hosts) {
      console.log(`${row.host}  ${row.status}${row.partial ? "  partial inventory" : ""}`);
      for (const t of row.targets || []) console.log(`  ${row.host}:${t.id}  ${t.kind}  ${t.status}${t.addressable ? "" : "  unavailable"}`);
    }
    process.exitCode = result.complete ? 0 : 3;
    return;
  }
  const result = await listInstalledTargets({ scope: options.scope, cwd: options.cwd || process.cwd() });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatTargets(result));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function printReceipt(handle) {
  console.error("relay receipt " + handle);
}

async function runSend(options) {
  // The CLI inherits its host session's environment, so a Claude session
  // shelling out identifies itself exactly as a Codex MCP call does.
  // The CLI inherits its host session's environment, so this face reads the
  // environment channel. It never sees request metadata, having no request.
  const hostIdentity = resolveCallerIdentity();
  let message = options.message;
  if (message === undefined) {
    if (process.stdin.isTTY) {
      console.error("relay: no message — pass --message <text> or pipe one on stdin");
      process.exitCode = 2;
      return;
    }
    message = (await readStdin()).trim();
  }
  if (!message) {
    console.error("relay: refusing to send an empty message");
    process.exitCode = 2;
    return;
  }

  const sendOptions = {
    message,
    dryRun: options.dryRun,
    allowDelegate: options.viaDelegate,
    origin: options.from,
    re: options.re,
    // The CLI inherits its host session's environment, so a Claude session
    // shelling out to relay identifies itself the same way a Codex MCP call
    // does. Same guarantee, different host.
    identity: hostIdentity,
    conversation: options.conversation,
    kind: options.kind,
    inReplyTo: options.inReplyTo,
  };
  const result = options.selector
    ? await sendBound(options.selector, sendOptions)
    : await sendAddressed({ ...sendOptions, to: options.to, requestId: options.requestId }, { onHandle: printReceipt });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(result.detail ?? result.state);
  } else {
    console.error(`relay: ${result.cause ?? result.state}`);
    if (result.detail) console.error(`  ${result.detail}`);
    if (result.adapters?.length) console.error(`  Adapters: ${JSON.stringify(result.adapters)}`);
    // Only report a location when something was actually written. Printing a
    // path that holds nothing sends an operator looking for a message that is
    // not there.
    if (result.spooled) console.error(`  message spooled to ${result.spooled}`);
    else if (result.spoolError) console.error(`  MESSAGE NOT SPOOLED: ${result.spoolError}`);
  }
  // A failed send must not look like a success to a script or a shell chain.
  if (!result.ok) process.exitCode = 1;
}

main().catch(() => {
  console.error("relay: operation failed; check the relay installation and machine directory");
  process.exitCode = 1;
});
