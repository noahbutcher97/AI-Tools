import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridge = fileURLToPath(new URL(".", import.meta.url));
const args = ["--no-warnings", "--experimental-loader", new URL("./fixtures/watcher-doctor-loader.mjs", import.meta.url).href];

test("CLI doctor publishes the bounded pause reason that a fresh read-only MCP caller sees", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-doctor-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const health = path.join(home, "installation", "completion-health");
  fs.mkdirSync(health, { recursive: true });
  const beatFile = path.join(health, "watcher.json");
  const stamp = new Date().toISOString();
  const paused = { id: "00000000-0000-4000-8000-000000000001", target: "00000000-0000-4000-8000-000000000002",
    condition: "file", state: "paused", reason: "stored_state_unverified" };
  const active = { ...paused, id: "00000000-0000-4000-8000-000000000003", state: "waiting" };
  delete active.reason;
  const beat = { v: 1, pid: 17, startedAt: stamp, heartbeat: stamp, mode: "watching", policyRevision: null,
    partial: true, subscriptions: [paused, active] };
  fs.writeFileSync(beatFile, JSON.stringify(beat));
  const env = { HOME: home, USERPROFILE: home, PATH: "", ...(process.platform === "win32" && {SystemRoot: process.env.SystemRoot}) };
  function doctor() {
    const result = spawnSync(process.execPath, [...args, "cli.mjs", "doctor", "--json"], { cwd: bridge, env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 3, result.stderr);
    return JSON.parse(result.stdout);
  }
  const original = doctor();
  assert.equal(original.watcher.state, "watching");
  assert.deepEqual(original.watcher.record.subscriptions, [paused, active]);
  const record = path.join(home, ".cross-agent-relay", "readiness.json");
  const bytes = fs.readFileSync(record);
  fs.unlinkSync(beatFile);
  const client = new Client({ name: "watcher-doctor-check", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...args, "server.mjs"], cwd: bridge, env, stderr: "pipe" }));
  try {
    const reply = await client.callTool({ name: "relay_doctor", arguments: {} });
    assert.deepEqual(JSON.parse(reply.content[0].text).record.watcher, original.watcher);
    assert.deepEqual(fs.readFileSync(record), bytes);
    assert.equal(fs.existsSync(beatFile), false);
  } finally { await client.close(); }
  const unsafe = "unexpected-display-value";
  fs.writeFileSync(beatFile, JSON.stringify({ ...beat, subscriptions: [{...paused, reason: unsafe}] }));
  const filtered = doctor();
  assert.deepEqual(filtered.watcher, { state: "unavailable", record: null });
  assert.ok(!JSON.stringify(filtered).includes(unsafe));
});
