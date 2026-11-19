import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable, PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { receive } from "./receive.mjs";

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
