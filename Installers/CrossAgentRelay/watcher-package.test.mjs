import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWatcherPackage, verifyWatcherPackage, packageFiles } from "./watcher-package.mjs";

test("partial branch packages preserve the previous broker's store format for rollback", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-rollback-"));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  const image = path.join(temp, "image");
  fs.writeFileSync(image, "fixture image");
  const next = path.join(temp, "next");
  const compile = (dir, member) => fs.copyFileSync(image, path.join(dir, member));
  const nextDigest = await buildWatcherPackage(next, { node: image, codex: image, claude: image, compile });
  const base = path.join(temp, "base");
  fs.cpSync(next, base, { recursive: true });
  const branch = "relay/branch-observation.mjs";
  fs.unlinkSync(path.join(base, branch));
  const jobs = "relay/completion-jobs.mjs";
  const manifestFile = path.join(base, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.files = manifest.files.filter(([member]) => member !== branch);
  const stage = path.join(temp, "stage");
  const updater = fileURLToPath(new URL("./Update-CompletionBroker.ps1", import.meta.url));
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const compatibleStore = fs.readFileSync(path.join(next, jobs), "utf8") + "\n// fixture edit\n";
  for (const older of ["const BROKER_STORE_VERSION = 4;", "// legacy store without a format declaration", compatibleStore]) {
    fs.writeFileSync(path.join(base, jobs), older);
    manifest.files.find(([member]) => member === jobs)[1] = digest(older);
    const body = JSON.stringify(manifest);
    fs.writeFileSync(manifestFile, body);
    const baseDigest = digest(body);
    const compatible = older === compatibleStore;
    const build = buildWatcherPackage(stage, { base, baseDigest, changedMember: "branches" });
    if (compatible) {
      assert.equal(await build, nextDigest);
    } else {
      await assert.rejects(build, /rollback.*format/i);
      assert.equal(fs.existsSync(stage), false);
    }
    if (process.platform === "win32") {
      // Plan and Apply take independently assembled packages through the real
      // entry point. Refusal precedes scheduler access and the elevation check.
      for (const operation of ["Plan", "Apply"]) {
        const command = "function New-Object { throw 'Unexpected scheduler access' }; " +
          "& $env:TEST_UPDATER -Operation $env:TEST_OPERATION -Component Branches " +
          "-PreviousPackage $env:TEST_BASE -PreviousDigest $env:TEST_BASE_DIGEST " +
          "-NextPackage $env:TEST_NEXT -NextDigest $env:TEST_NEXT_DIGEST";
        const attempt = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, TEST_UPDATER: updater,
            TEST_OPERATION: operation, TEST_BASE: base, TEST_BASE_DIGEST: baseDigest, TEST_NEXT: next, TEST_NEXT_DIGEST: nextDigest },
        });
        assert.equal(attempt.status, 1);
        assert.match(attempt.stderr, compatible ? /Unexpected scheduler access/ : /rollback.*format/i);
      }
    }
  }
});

test("partial staging refuses state module bytes that changed after the compatibility check", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stage-"));
  t.after(() => fs.rmSync(temp, { recursive: true }));
  const image = path.join(temp, "image");
  fs.writeFileSync(image, "fixture image");
  const base = path.join(temp, "base");
  const compile = (dir, member) => fs.copyFileSync(image, path.join(dir, member));
  await buildWatcherPackage(base, { node: image, codex: image, claude: image, compile });
  const metadata = path.join(base, "package.json");
  const manifest = JSON.parse(fs.readFileSync(metadata));
  const jobs = "relay/completion-jobs.mjs";
  const oldJobs = "fixture prior store";
  fs.writeFileSync(path.join(base, jobs), oldJobs);
  manifest.files.find(([member]) => member === jobs)[1] = createHash("sha256").update(oldJobs).digest("hex");
  const body = JSON.stringify(manifest);
  fs.writeFileSync(metadata, body);
  const baseDigest = createHash("sha256").update(body).digest("hex");

  // stage-branch-update preserves the base jobs module. Only the first
  // source read sees a schedule compatible with this partial update.
  const schedule = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/schedule-watch.mjs", import.meta.url));
  const replacement = path.join(temp, "next-schedule.mjs");
  fs.writeFileSync(replacement, "fixture next schedule");
  const open = fs.promises.open;
  let reads = 0;
  fs.promises.open = function (file, ...args) {
    return open.call(this, file === schedule && ++reads === 2 ? replacement : file, ...args);
  };
  const out = path.join(temp, "staged");
  try {
    await assert.rejects(buildWatcherPackage(out, { base, baseDigest, changedMember: "branch-update" }), /State module changed/);
  } finally { fs.promises.open = open; }
  assert.equal(reads, 2);
  assert.equal(fs.existsSync(out), false);
});

test("watcher package contains a complete protected import closure and an empty job database", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-package-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const image = path.join(temp, "image");
  fs.writeFileSync(image, "fixture image");
  const out = path.join(temp, "bundle");
  const compile = (dir, member) => fs.copyFileSync(image, path.join(dir, member));
  const digest = await buildWatcherPackage(out, { node: image, claude: image, codex: image, compile });
  assert.equal(await verifyWatcherPackage(out, digest), digest);
  // Import the actual staged entry points. Neither probe should launch the
  // native helper or require modules that exist only in the source checkout.
  const stagedModule = name => import(pathToFileURL(path.join(out, "relay", name + ".mjs")).href);
  const { startCompletionBroker } = await stagedModule("completion-broker");
  await stagedModule("completion-worker");
  for (const member of packageFiles.filter(p => p.endsWith(".mjs"))) {
    const file = fs.readFileSync(path.join(out, member), "utf8");
    for (const [, name] of file.matchAll(/(?:from\s+|import\()["'](\.\/[^"']+\.mjs)["']/g)) {
      assert.ok(packageFiles.includes("relay/" + name.slice(2)), "missing dependency of " + member);
    }
  }
  const db = new DatabaseSync(path.join(out,"initial","jobs.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0); } finally { db.close(); }
  const installed = path.join(temp, "profile");
  for (const dir of ["completion-state", "completion-health"]) fs.mkdirSync(path.join(installed, dir), { recursive: true });
  fs.copyFileSync(path.join(out,"initial","jobs.sqlite"), path.join(installed,"completion-state","jobs.sqlite"));
  fs.writeFileSync(path.join(installed, "completion-policy.json"), JSON.stringify({ v: 1, grants: [] }));
  for (let boot = 0; boot < 2; boot++) {
    const broker = await startCompletionBroker(installed, { port: 0, publishHealth: true });
    try {
      await assert.rejects(startCompletionBroker(installed, { port: broker.port }), { code: "EADDRINUSE" });
      const { readWatcher } = await stagedModule("watcher-health");
      assert.equal(readWatcher(installed).state, "reports_only");
    } finally { await broker.close(); }
  }
  const migrated = new DatabaseSync(path.join(installed, "completion-state", "jobs.sqlite"), { readOnly: true });
  try {
    const format = migrated.prepare("PRAGMA user_version").get().user_version;
    const storeModule = fs.readFileSync(path.join(out, "relay/completion-jobs.mjs"), "utf8");
    assert.ok(storeModule.split(/\r?\n/).includes(`const BROKER_STORE_VERSION = ${format};`));
  } finally { migrated.close(); }
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
  const preserved = "relay/run-handoff.mjs";
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
  const incompatible = path.join(temp, "partial");
  const oldJobs = "fixture prior job store";
  fs.writeFileSync(path.join(prior, "relay/completion-jobs.mjs"), oldJobs);
  metadata.files.find(([member]) => member === "relay/completion-jobs.mjs")[1] = createHash("sha256").update(oldJobs).digest("hex");
  const oldStoreMetadata = JSON.stringify(metadata);
  fs.writeFileSync(path.join(prior, "package.json"), oldStoreMetadata);
  await assert.rejects(buildWatcherPackage(incompatible, {
    base: prior, baseDigest: createHash("sha256").update(oldStoreMetadata).digest("hex"), changedMember: "branch-update",
  }), /complete watcher package/);
  assert.equal(fs.existsSync(incompatible), false);
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
