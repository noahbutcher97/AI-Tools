import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sampleInstalledFile } from "./file-watch.mjs";

test("Windows reads metadata from the granted root and rejects redirects during lookup", {
  skip: process.platform !== "win32",
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-observe-"));
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const root = path.join(dir, "approved");
  const neighbor = path.join(dir, "neighbor");
  const file = path.join(root, "item");
  const alternate = path.join(neighbor, "item");
  const link = path.join(root, "redirect");
  const hard = path.join(root, "alias");
  const modules = path.join(dir, "relay");
  const image = path.join(modules, "FileObservation.exe");
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(neighbor);
    fs.mkdirSync(modules);
    fs.writeFileSync(file, "abc");
    fs.writeFileSync(alternate, "different");
    fs.linkSync(alternate, hard);
    fs.symlinkSync(neighbor, link, "junction");
    const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Path $env:RELAY_TEST_SOURCE
$root = Join-Path $env:RELAY_TEST_DIR 'approved'
$drive = [IO.Path]::GetPathRoot($root)
$mount = (& (Join-Path ([Environment]::SystemDirectory) 'mountvol.exe') $drive /L | Out-String).Trim()
if ($LASTEXITCODE -or $mount -notmatch '\{([a-fA-F0-9-]{36})\}\\$') { throw 'Missing local volume' }
$volume = $Matches[1]
$dir = $root.Substring($drive.Length).Replace('\','/')
$id = [FileObservation]::RootIdentity($volume,$dir)
function Sample([string]$name) { [FileObservation]::Sample($volume,$dir,$id,$name) }
function Denied([scriptblock]$call) {
    try { $null = & $call } catch [System.Management.Automation.MethodInvocationException] { return }
    throw 'Unexpected metadata access'
}
$first = Sample 'item'
if ($first -cnotmatch '^[a-f0-9]{48}:[a-f0-9]{16}:[a-f0-9]{16}$' -or (Sample 'item') -cne $first) {
    throw 'Unstable baseline'
}
Denied { Sample 'redirect/item' }
Denied { Sample 'alias' }
Denied { Sample '../neighbor/item' }
Denied { Sample 'item:stream' }
Denied { Sample '/item' }
Denied { Sample 'item\other' }
Denied { [FileObservation]::RootIdentity($volume,$dir+'/redirect') }
Denied { [FileObservation]::Sample($volume,$dir,('0'*48),'item') }
$file = Join-Path $root 'item'
$time = [IO.File]::GetLastWriteTimeUtc($file)
[IO.File]::Move($file,(Join-Path $root 'old'))
if ((Sample 'item') -cne 'absent') { throw 'Rename did not confirm disappearance' }
[IO.File]::WriteAllBytes($file,[byte[]](1,2,3))
[IO.File]::SetLastWriteTimeUtc($file,$time)
$second = Sample 'item'
if ($first.Substring(48) -cne $second.Substring(48) -or $first -ceq $second) { throw 'Missed replacement' }
$saved = Join-Path $env:RELAY_TEST_DIR 'saved'
[IO.Directory]::Move($root,$saved)
try {
    [void][IO.Directory]::CreateDirectory($root)
    Denied { Sample 'item' }
    [IO.File]::WriteAllBytes((Join-Path $root 'item'),[byte[]](1))
    Denied { Sample 'item' }
} finally {
    [IO.File]::Delete((Join-Path $root 'item'))
    [IO.Directory]::Delete($root,$false)
    [IO.Directory]::Move($saved,$root)
}
@{ volume=$volume; directory=$dir; rootId=$id } | ConvertTo-Json -Compress
`;
    const result = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: dir, windowsHide: true, timeout: 30000, encoding: "utf8",
      env: { ...process.env, RELAY_TEST_DIR: dir,
        RELAY_TEST_SOURCE: fileURLToPath(new URL("./FileObservation.cs", import.meta.url)) },
    });
    const grant = { ...JSON.parse(result), condition: randomUUID(), target: randomUUID(), provider: "codex",
      scope: "thread-file-change", file: "item", expiresAt: new Date(Date.now()+60000).toISOString() };
    const framework = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319");
    execFileSync(path.join(framework, "csc.exe"), ["/noconfig", "/nologo", "/target:winexe", "/reference:" + path.join(framework,"System.dll"),
      "/out:" + image, fileURLToPath(new URL("./FileObservation.cs", import.meta.url))],
    { cwd: dir, timeout: 20000, windowsHide: true });
    assert.match(await sampleInstalledFile(dir, grant), /^[a-f0-9]{48}:[a-f0-9]{16}:[a-f0-9]{16}$/);
    assert.equal(await sampleInstalledFile(dir, { ...grant, file: "missing" }), "absent");
    await assert.rejects(sampleInstalledFile(dir, { ...grant, file: "redirect/item" }), /unavailable/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    for (const item of [hard, alternate, file, image, path.join(root, "old")]) {
      if (fs.existsSync(item)) fs.unlinkSync(item);
    }
    for (const directory of [neighbor, root, modules, dir]) {
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    }
  }
});
