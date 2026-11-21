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
// send reaches Codex threads only. Claude targets are refused by name with the
// reason: SendMessage is an in-session tool, so a shell-invocable path to a
// Claude session needs the delegate that Unit 3 adds.

import { formatTargets, parseArgs } from "./client.mjs";
import { listInstalledTargets, resolveLocalAddress } from "./local-address.mjs";
import { pingTarget, sendAddressed, sendStatus } from "./addressed-send.mjs";
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
  ping <target>                Wake the session once and check for delivery
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
  if (args.length === 2 && args[0] === "resolve" && ["-h", "--help"].includes(args[1])) {
    console.log(resolveHelp);
    return;
  }
  if (args.length === 1 && ["help", "-h", "--help"].includes(args[0]) ||
      args.length === 2 && ["list","send","ping","doctor","watch","run"].includes(args[0]) &&
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
    const result = options.statusHandle ? await sendStatus(options.statusHandle) : await pingTarget(options.to, {
      allowDelegate: options.viaDelegate, onHandle: handle => console.error("relay receipt " + handle),
    });
    console.log(options.json ? JSON.stringify(result) : result.detail);
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

  const result = await sendAddressed({
    to: options.to,
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
    requestId: options.requestId,
  }, { onHandle: handle => console.error("relay receipt " + handle) });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(result.detail);
  } else {
    console.error(`relay: ${result.cause}`);
    console.error(`  ${result.detail}`);
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
