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

import { discoverTargets, formatTargets, parseArgs, sendMessage } from "./client.mjs";
import { resolveCallerIdentity } from "./identity.mjs";

// node:sqlite is experimental and announces itself on every load. The warning
// is noise here and would be noise in a bridge log, so it is filtered while
// every other warning still prints.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
  console.error(`${warning.name}: ${warning.message}`);
});

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`relay: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  if (options.command === "send") {
    await runSend(options);
    return;
  }

  const result = await discoverTargets({ scope: options.scope, cwd: options.cwd || process.cwd() });

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

  const result = await sendMessage({
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
  });

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

await main();
