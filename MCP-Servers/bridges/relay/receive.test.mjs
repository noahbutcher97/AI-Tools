import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { receive } from "./receive.mjs";
import { addIndexedSession } from "./fixtures/session-index.mjs";

const binding = ["--peer", "host-a", "--host", "host-b"];
const request = { v: 1, op: "probe", requestId: "00000000-0000-4000-8000-000000000001" };
const frame = JSON.stringify(request);

test("receive CLI returns only the fixed key binding and correlated probe result", () => {
  const cli = fileURLToPath(new URL("cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "receive", ...binding], {
    input: frame, encoding: "utf8", env: { ...process.env, SSH_ORIGINAL_COMMAND: "relay receive" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ...request, ok: true, peer: "host-a", host: "host-b" });
});

test("denied invocations never consume input", async () => {
  const unreadable = { get [Symbol.asyncIterator]() { assert.fail("unexpected read"); } };
  for (const command of [undefined, "", "relay receive ", "relay receive --peer host-b", "other"]) {
    assert.deepEqual(await receive(binding, command, unreadable), { ok: false, error: "receive_denied" });
  }
  for (const args of [[], [...binding, "--other"], ["--peer", "-x", "--host", "ok"],
    ["--peer", "host-a", "--host", "invalid\nlabel"]]) {
    assert.deepEqual(await receive(args, "relay receive", unreadable), { ok: false, error: "receive_denied" });
  }
});

test("the Windows receive command resolves only in its enrolled host and enabled readers", {
  skip: process.platform !== "win32",
}, async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return t.skip("node:sqlite unavailable"); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-receive-profile-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const install = path.join(profile, "CrossAgentRelay");
  const config = (file, value) => fs.writeFileSync(path.join(install, file), JSON.stringify(value));
  const store = path.join(profile, ".codex");
  const id = "00000000-0000-4000-8000-000000000002";
  fs.mkdirSync(path.join(install, "provider"), { recursive: true });
  // Resolve checks installation availability but never starts this sentinel.
  fs.writeFileSync(path.join(install, "provider", "codex.exe"), "");
  fs.mkdirSync(path.join(store, "thread-writer-locks"), { recursive: true });
  fs.writeFileSync(path.join(store, "thread-writer-locks", id + ".lock"), "");
  const claude = path.join(profile, ".claude", "sessions");
  fs.mkdirSync(claude, { recursive: true });
  addIndexedSession(DatabaseSync, store, id, profile);
  config("machine.json", { host: "host-b" });
  config("inventory-adapters.json", { enabled: ["codex"] });
  config("receive-policy.json", { enabled: true, codex: [{ peer: "host-a", ids: [id] }] });
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/receive-test-root.cjs", import.meta.url));
  const resolve = () => {
    const result = spawnSync(process.execPath, ["--require", preload, cli, "receive", ...binding], {
      input: JSON.stringify({ v: 2, op: "resolve", requestId: request.requestId, host: "host-b", to: id }),
      env: { ...process.env, RELAY_RECEIVE_TEST_ROOT: profile, HOME: profile, USERPROFILE: profile, SSH_ORIGINAL_COMMAND: "relay receive" },
      encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const reply = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(reply).sort(), ["host", "ok", "op", "peer", "requestId", "state", "v"]);
    assert.equal(reply.requestId, request.requestId);
    return reply.state;
  };
  assert.equal(resolve(), "eligible");
  config("inventory-adapters.json", { enabled: ["claude"] });
  assert.equal(resolve(), "unresolved");
  config("inventory-adapters.json", { enabled: ["codex", "claude"] });
  fs.writeFileSync(path.join(claude, "fixture.json"), JSON.stringify({ sessionId: id, cwd: profile }));
  assert.equal(resolve(), "unresolved");
  config("inventory-adapters.json", { enabled: ["codex"] });
  assert.equal(resolve(), "eligible");
  config("machine.json", { host: "host-c" });
  assert.equal(resolve(), "unresolved");
  assert.equal(fs.existsSync(path.join(install, "receipts.sqlite")), false);
});

test("probe rejects malformed and extra input without reflecting any bytes", async () => {
  const invalid = [
    "", "null", "[]", frame + frame, frame.replace('"v":1', '"v":1,"v":1'),
    frame.replace('"v":1', '"v":2'), JSON.stringify({ ...request, op: "send" }),
    JSON.stringify({ ...request, peer: "host-c" }), JSON.stringify({ ...request, requestId: {} }),
    JSON.stringify({ ...request, requestId: "unknown" }), " ".repeat(513),
    Buffer.from([0xff]), Buffer.from("\ufeff" + frame),
  ];
  for (const value of invalid) {
    const stream = Readable.from([Buffer.from(value)]);
    assert.deepEqual(await receive(binding, "relay receive", stream), { ok: false, error: "invalid_frame" });
  }
});

test("an incomplete stream has a deadline even when a peer stops writing", async () => {
  const stream = new PassThrough();
  stream.write("{");
  assert.deepEqual(await receive(binding, "relay receive", stream, 20), { ok: false, error: "deadline" });
});
