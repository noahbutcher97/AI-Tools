import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateInstalledReceipts } from "./Migrate-RelayReceipts.mjs";

const entry = fileURLToPath(new URL("./Migrate-RelayReceipts.mjs", import.meta.url));
const preload = fileURLToPath(new URL("../../MCP-Servers/bridges/relay/fixtures/receive-test-root.cjs", import.meta.url));
const baseline = `CREATE TABLE receipts (peer TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
  state TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(peer,id)) WITHOUT ROWID;
  CREATE TABLE proofs (peer TEXT NOT NULL, id TEXT NOT NULL, cursor TEXT NOT NULL, expected TEXT NOT NULL,
  PRIMARY KEY(peer,id)) WITHOUT ROWID; PRAGMA user_version=2;`;

test("setup migrates an existing store once and retains pre-upgrade receipts", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-setup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "CrossAgentRelay");
  fs.mkdirSync(root);
  const file = path.join(root, "receipts.sqlite");
  await assert.rejects(() => migrateInstalledReceipts(root));
  assert.equal(fs.existsSync(file), false);
  const db = new DatabaseSync(file);
  try {
    db.exec(baseline);
    db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)").run("host-a", "old-id", "original-digest", "unknown", 10);
  } finally { db.close(); }
  await migrateInstalledReceipts(root);
  if (process.platform === "win32") {
    const invoke = spawnSync(process.execPath, ["--require", preload, entry], {
      env: { ...process.env, RELAY_RECEIVE_TEST_ROOT: home }, encoding: "utf8",
    });
    assert.equal(invoke.status, 0, invoke.stderr);
    assert.match(invoke.stdout, /ready/);
  } else {
    await migrateInstalledReceipts(root);
  }
  const updated = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(updated.prepare("PRAGMA user_version").get().user_version, 3);
    const row = updated.prepare("SELECT digest,state,created FROM receipts WHERE peer=? AND id=?").get("host-a", "old-id");
    assert.deepEqual({ ...row }, { digest: "original-digest", state: "unknown", created: 10 });
  } finally { updated.close(); }
  const invalid = spawnSync(process.execPath, [entry, "--file", file], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stderr, /receipt-setup-/);
});

test("setup refuses a linked database or a redirected installation", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-redirect-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "fixture");
  fs.mkdirSync(root);
  const protectedFile = path.join(root, "receipts.sqlite");
  const db = new DatabaseSync(protectedFile);
  try { db.exec(baseline); } finally { db.close(); }
  const before = fs.readFileSync(protectedFile);
  const redirected = path.join(tmp, "redirect");
  fs.symlinkSync(root, redirected, "junction");
  await assert.rejects(() => migrateInstalledReceipts(redirected), /Invalid receipt store/);
  fs.linkSync(protectedFile, path.join(tmp, "second-link"));
  await assert.rejects(() => migrateInstalledReceipts(root), /Invalid receipt store/);
  assert.deepEqual(fs.readFileSync(protectedFile), before);
});
