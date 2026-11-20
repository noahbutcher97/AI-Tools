import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWatcherPackage, verifyWatcherPackage, packageFiles } from "./watcher-package.mjs";

test("watcher package contains a complete protected import closure and an empty job database", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-package-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const image = path.join(temp, "image");
  fs.writeFileSync(image, "fixture image");
  const out = path.join(temp, "bundle");
  const compile = (dir, member) => fs.copyFileSync(image, path.join(dir, member));
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
  assert.equal(await buildWatcherPackage(path.join(temp, "acl"), {
    base: out, baseDigest: digest, changedMember: "relay/completion-acl.ps1",
  }), digest);
  await assert.rejects(buildWatcherPackage(path.join(temp, "forbidden"), {
    base: out, baseDigest: digest, changedMember: "provider/codex.exe",
  }), /Unsupported/);
  fs.writeFileSync(path.join(out, "relay", "package.json"), "{}");
  await assert.rejects(verifyWatcherPackage(out, digest), /Unexpected/);
  fs.unlinkSync(path.join(out, "relay", "package.json"));
  const legacy = path.join(temp, "legacy");
  const prior = path.join(temp, "prior");
  fs.cpSync(out, prior, { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(prior, "package.json")));
  const updatedModules = ["relay/schedule-watch.mjs", "relay/branch-observation.mjs", "relay/completion-broker.mjs"];
  const preserved = "relay/completion-jobs.mjs";
  for (const entry of metadata.files) {
    if (![...updatedModules, preserved].includes(entry[0])) continue;
    const bytes = "fixture prior version of " + entry[0];
    fs.writeFileSync(path.join(prior, entry[0]), bytes);
    entry[1] = createHash("sha256").update(bytes).digest("hex");
  }
  const manifestBytes = JSON.stringify(metadata);
  const priorDigest = createHash("sha256").update(manifestBytes).digest("hex");
  fs.writeFileSync(path.join(prior, "package.json"), manifestBytes);
  const staged = path.join(temp, "refresh");
  const cli = fileURLToPath(new URL("./watcher-package.mjs", import.meta.url));
  const stage = hash => spawnSync(process.execPath, [cli, "stage-branch-update", staged, prior, hash], { encoding: "utf8" });
  const rejected = stage("0".repeat(64));
  assert.equal(rejected.status, 1);
  assert.equal(fs.existsSync(staged), false);
  const accepted = stage(priorDigest);
  assert.equal(accepted.status, 0, accepted.stderr);
  await verifyWatcherPackage(staged, accepted.stdout.trim());
  for (const [member] of metadata.files) {
    const expectedRoot = updatedModules.includes(member) ? out : prior;
    assert.deepEqual(fs.readFileSync(path.join(staged, member)), fs.readFileSync(path.join(expectedRoot, member)), member);
  }
  fs.cpSync(out, legacy, { recursive: true });
  fs.unlinkSync(path.join(legacy, "relay/branch-observation.mjs"));
  const old = JSON.parse(fs.readFileSync(path.join(legacy, "package.json"), "utf8"));
  old.files = old.files.filter(([member]) => member !== "relay/branch-observation.mjs");
  const fileManifest = JSON.stringify(old);
  fs.writeFileSync(path.join(legacy, "package.json"), fileManifest);
  assert.equal(await buildWatcherPackage(path.join(temp, "branches"), {
    base: legacy, baseDigest: createHash("sha256").update(fileManifest).digest("hex"), changedMember: "branches",
  }), digest);
  const additions = ["relay/file-watch.mjs", "relay/FileObservation.cs", "relay/FileObservation.exe"];
  for (const member of additions) fs.unlinkSync(path.join(legacy, member));
  old.files = old.files.filter(([member]) => !additions.includes(member));
  const scheduleManifest = JSON.stringify(old);
  fs.writeFileSync(path.join(legacy, "package.json"), scheduleManifest);
  assert.equal(await buildWatcherPackage(path.join(temp, "files"), {
    base: legacy, baseDigest: createHash("sha256").update(scheduleManifest).digest("hex"), changedMember: "files", compile,
  }), digest);
  fs.unlinkSync(path.join(legacy, "relay/schedule-watch.mjs"));
  old.files = old.files.filter(([member]) => member !== "relay/schedule-watch.mjs");
  const oldManifest = JSON.stringify(old);
  const oldDigest = createHash("sha256").update(oldManifest).digest("hex");
  fs.writeFileSync(path.join(legacy, "package.json"), oldManifest);
  await assert.rejects(verifyWatcherPackage(legacy, oldDigest));
  assert.equal(await buildWatcherPackage(path.join(temp, "schedules"), {
    base: legacy, baseDigest: oldDigest, changedMember: "schedules", compile,
  }), digest);
  fs.writeFileSync(path.join(out,"provider","codex.exe"), "changed");
  await assert.rejects(verifyWatcherPackage(out, digest));
  fs.copyFileSync(image, path.join(out,"provider","codex.exe"));
  const dir = path.join(out, "provider");
  const moved = path.join(temp, "moved");
  fs.renameSync(dir, moved);
  fs.symlinkSync(moved, dir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyWatcherPackage(out, digest), /Unexpected/);
});
