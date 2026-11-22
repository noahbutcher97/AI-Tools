import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendMessage } from "./client.mjs";
import { recoveryFixture } from "./fixtures/private-spool.mjs";

const body = "Synthetic recovery fixture.\nSecond line.";

function fail(root, file) {
  return sendMessage({ to: "fixture", message: body, claudeSessionsDir: root, codexHome: root, spoolPath: file });
}

function grantRead(file, directory = false) {
  if (process.platform === "win32") {
    execFileSync(path.join(process.env.SystemRoot, "System32", "icacls.exe"), [file, "/grant", "*S-1-1-0:R"]);
  } else {
    fs.chmodSync(file, directory ? 0o755 : 0o644);
  }
}

test("a new private spool confines recovery to its owner", async () => {
  const root = recoveryFixture();
  const dir = path.join(root, "private");
  const file = path.join(dir, "spool.log");
  const result = await fail(root, file);
  assert.equal(result.spoolError, null);
  assert.ok(fs.readFileSync(file, "utf8").includes(body));
  assert.ok(!JSON.stringify(result).includes(root));
  if (process.platform === "win32") {
    const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const check = [
      "$ErrorActionPreference='Stop'",
      "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
      "$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "foreach($p in @($env:RELAY_TEST_PRIVATE,(Split-Path $env:RELAY_TEST_PRIVATE))) {",
      "$acl=Get-Acl -LiteralPath $p",
      "if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) {exit 1}",
      "foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($r.IdentityReference.Value -ne $user) { exit 1 } }",
      "}",
    ].join("\n");
    execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", check], { env: { ...process.env, RELAY_TEST_PRIVATE: file } });
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test("unavailable storage reports no recovery and leaves the temporary directory empty", async t => {
  const root = recoveryFixture();
  const temp = path.join(root, "temp");
  fs.mkdirSync(temp);
  t.mock.method(os, "tmpdir", () => temp);
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "fixture");
  const result = await fail(root, path.join(blocker, "spool.log"));
  assert.equal(result.spooled, null);
  assert.match(result.spoolError, /did not save a recoverable copy/);
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(!JSON.stringify(result).includes(body));
  assert.deepEqual(fs.readdirSync(temp), []);
});

for (const mode of ["readable directory", "readable file", "hard link", "redirected ancestor"]) {
  test("private recovery refuses a " + mode, async () => {
    const root = recoveryFixture();
    const dir = path.join(root, "private");
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, "spool.log");
    if (mode === "readable directory") grantRead(dir, true);
    if (mode === "readable file") {
      fs.writeFileSync(file, "before", { mode: 0o600 });
      grantRead(file);
    }
    if (mode === "hard link") {
      const source = path.join(root, "original");
      fs.writeFileSync(source, "before", { mode: 0o600 });
      fs.linkSync(source, file);
    }
    let candidate = file;
    if (mode === "redirected ancestor") {
      const link = path.join(root, "link");
      fs.symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
      candidate = path.join(link, "spool.log");
    }
    const result = await fail(root, candidate);
    assert.equal(result.spooled, null);
    if (["hard link", "readable file"].includes(mode)) assert.equal(fs.readFileSync(file, "utf8"), "before");
    else assert.equal(fs.existsSync(file), false);
  });
}

test("a stalled Windows permission check frees the event loop and ends without retaining the body", {
  skip: process.platform !== "win32", timeout: 20000,
}, async () => {
  const root = recoveryFixture();
  for (const name of ["client.mjs", "identity.mjs", "delivery-protocol.mjs", "provider-process.mjs"]) {
    fs.copyFileSync(new URL(name, import.meta.url), path.join(root, name));
  }
  const file = path.join(root, "spool.log");
  const pidFile = file + ".pid";
  fs.writeFileSync(path.join(root, "private-spool.ps1"),
    '$Path=[Console]::In.ReadToEnd()\n[IO.File]::WriteAllText($Path + ".pid", [string]$PID)\n[Threading.Thread]::Sleep(30000)');
  const client = await import(pathToFileURL(path.join(root, "client.mjs")));
  const options = { to: "fixture", message: body, claudeSessionsDir: root, codexHome: root, spoolPath: file };
  const dryRun = await client.sendMessage({ ...options, dryRun: true });
  assert.equal(dryRun.cause, "target_not_found");
  assert.equal(fs.existsSync(pidFile), false);
  let pidWhileRunning;
  const poll = setInterval(() => {
    if (fs.existsSync(pidFile)) pidWhileRunning = Number(fs.readFileSync(pidFile, "utf8"));
  }, 50);
  try {
    const result = await client.sendMessage(options);
    assert.equal(result.spooled, null);
    assert.match(result.spoolError, /did not save a recoverable copy/);
    assert.ok(pidWhileRunning > 0);
    assert.throws(() => process.kill(pidWhileRunning, 0), { code: "ESRCH" });
    assert.equal(fs.existsSync(file), false);
  } finally { clearInterval(poll); }
});
