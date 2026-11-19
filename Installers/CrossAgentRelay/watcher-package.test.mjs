import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildWatcherPackage, verifyWatcherPackage, packageFiles } from "./watcher-package.mjs";

test("watcher package contains a complete protected import closure and an empty job database", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-package-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const image = path.join(temp, "image");
  fs.writeFileSync(image, "fixture image");
  const out = path.join(temp, "bundle");
  const compile = dir => fs.copyFileSync(image, path.join(dir, "CompletionChannel.exe"));
  const digest = await buildWatcherPackage(out, { node: image, claude: image, codex: image, compile });
  assert.equal(await verifyWatcherPackage(out, digest), digest);
  for (const member of packageFiles.filter(p => p.endsWith(".mjs"))) {
    const file = fs.readFileSync(path.join(out, member), "utf8");
    for (const [, name] of file.matchAll(/(?:from\s+|import\()["'](\.\/[^"']+\.mjs)["']/g)) {
      assert.ok(packageFiles.includes("relay/" + name.slice(2)), "missing dependency of " + member);
    }
  }
  const db = new DatabaseSync(path.join(out,"initial","jobs.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0); } finally { db.close(); }
  await assert.rejects(buildWatcherPackage(out, { node: image, claude: image, codex: image }));
  await assert.rejects(verifyWatcherPackage(out, "a".repeat(64)));
  const updated = path.join(temp, "updated");
  await assert.rejects(buildWatcherPackage(updated, { base: out, baseDigest: "0".repeat(64) }));
  assert.equal(fs.existsSync(updated), false);
  // This fixture already contains the current broker. Repackaging must keep every byte.
  assert.equal(await buildWatcherPackage(updated, { base: out, baseDigest: digest }), digest);
  assert.equal(await verifyWatcherPackage(updated, digest), digest);
  fs.writeFileSync(path.join(out, "relay", "package.json"), "{}");
  await assert.rejects(verifyWatcherPackage(out, digest), /Unexpected/);
  fs.unlinkSync(path.join(out, "relay", "package.json"));
  fs.writeFileSync(path.join(out,"provider","codex.exe"), "changed");
  await assert.rejects(verifyWatcherPackage(out, digest));
  fs.copyFileSync(image, path.join(out,"provider","codex.exe"));
  const dir = path.join(out, "provider");
  const moved = path.join(temp, "moved");
  fs.renameSync(dir, moved);
  fs.symlinkSync(moved, dir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyWatcherPackage(out, digest), /Unexpected/);
});
