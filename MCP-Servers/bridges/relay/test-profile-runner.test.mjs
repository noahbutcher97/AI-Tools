import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("./fixtures/run-with-test-profile.mjs", import.meta.url));
const invoke = args => spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 20000 });

test("help and invalid invocations allocate no profile", () => {
  assert.match(invoke(["--help"]).stdout, /Usage:/);
  const invalid = invoke(["--cleanup", "old-run"]);
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stderr, /Disposable test profile:/);
});

test("successful and failing children retain their status and clean only their own profile", t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "runner-sentinel-"));
  t.after(() => fs.rmSync(outside, { recursive: true }));
  const sentinel = path.join(outside, "keep");
  fs.writeFileSync(sentinel, "unchanged");
  const profiles = new Set();
  for (const code of [0, 7]) {
    const child = invoke(["--", "node", "-e", `
      const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
      const profile = os.homedir();
      fs.writeFileSync(path.join(os.tmpdir(), "file"), "fixture");
      fs.symlinkSync(process.argv[1], path.join(profile, "link"), "junction");
      console.log(JSON.stringify({ profile, tmp: os.tmpdir(), args: process.argv.slice(2) }));
      process.exitCode = Number(process.argv[3]);
    `, outside, "literal argument with spaces", String(code)]);
    assert.equal(child.status, code, child.stderr);
    const data = JSON.parse(child.stdout);
    assert.equal(path.dirname(data.tmp), data.profile);
    assert.deepEqual(data.args, ["literal argument with spaces", String(code)]);
    profiles.add(data.profile);
    assert.equal(fs.existsSync(data.profile), false);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
  }
  assert.equal(profiles.size, 2);
});

test("a replaced profile is reported and its replacement survives", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "runner-replacement-"));
  t.after(() => fs.rmSync(parent, { recursive: true }));
  const child = invoke(["--", "node", "-e", `
    const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
    const profile = os.homedir(), moved = path.join(process.argv[1], "original");
    fs.renameSync(profile, moved);
    fs.symlinkSync(moved, profile, "junction");
    console.log(JSON.stringify(profile));
  `, parent]);
  assert.equal(child.status, 1, child.stderr);
  const link = JSON.parse(child.stdout);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  t.after(() => fs.unlinkSync(link));
  assert.ok(child.stderr.includes(link));
  assert.match(child.stderr, /redirected|changed/);
  assert.ok(fs.existsSync(path.join(parent, "original", "tmp")));
});
