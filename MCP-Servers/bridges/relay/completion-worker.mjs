import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localStatus, sendProvedNotice } from "./local-ping.mjs";
import { frameIO, serveSession } from "./completion-session.mjs";
import { runProvider } from "./provider-process.mjs";
import { exactKeys } from "./delivery-protocol.mjs";

export function workerEnabled(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "completion-worker.json"), "utf8"));
    return exactKeys(value, ["v", "enabled"]) && value.v === 1 && value.enabled === true;
  } catch { return false; }
}

export function installedQueue(root, id, envelope, run = runProvider) {
  return run(path.join(root, "provider", "codex.exe"), ["queue", "--thread", id, "--message", envelope],
    { cwd: path.join(root, "worker-cwd") });
}

export function installedDelegate(root, invocation, run = runProvider) {
  return run(path.join(root, "provider", "claude.exe"),
    ["--model", "haiku", "--effort", "low", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', ...invocation.args],
    { cwd: path.join(root, "worker-cwd"), stdin: invocation.stdin });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
    const root = fileURLToPath(new URL("../", import.meta.url));
    await serveSession(frameIO(process.stdin, process.stdout), {
      enabled: provider => workerEnabled(root) && (provider !== "codex" || fs.existsSync(path.join(root, "provider", "codex.exe"))),
      send: (to, text, options) => sendProvedNotice(to, text, {
        ...options, runDelegate: invocation => installedDelegate(root, invocation),
        runQueue: (id, envelope) => installedQueue(root, id, envelope),
      }), status: localStatus,
    });
  } catch { process.exitCode = 1; }
}
