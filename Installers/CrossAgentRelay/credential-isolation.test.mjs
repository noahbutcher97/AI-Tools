import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the broker challenge rejects unsafe inputs and preserves recovery evidence when cleanup fails", {
  skip: process.platform !== "win32",
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-credential-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./fixtures/BranchCredentialCheck.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture, "-FixtureRoot", root],
    { windowsHide: true, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
});
