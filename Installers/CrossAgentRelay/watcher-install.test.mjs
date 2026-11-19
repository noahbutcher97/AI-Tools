import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildWatcherPackage } from "./watcher-package.mjs";

test("the Windows watcher installer preserves the owner policy and state across failures and rollback", {
  skip: process.platform !== "win32",
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-setup-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const image = path.join(temp, "fixture");
  fs.writeFileSync(image, "fixture image");
  const bundle = path.join(temp, "bundle");
  const digest = await buildWatcherPackage(bundle, { node: image, claude: image, codex: image });
  const script = fileURLToPath(new URL("./fixtures/WatcherSetupCheck.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
    "-FixtureRoot", temp, "-Bundle", bundle, "-Digest", digest], { encoding: "utf8", windowsHide: true, timeout: 45000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /reactivation passed/);
});
