import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendMessage } from "./client.mjs";

function fixture(t, sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-binding-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "registry");
  fs.mkdirSync(dir);
  for (const session of sessions) {
    fs.writeFileSync(path.join(dir, session.pid + ".json"), JSON.stringify(session));
  }
  return {
    to: "session-a", message: "test notice", claudeSessionsDir: dir, codexHome: home,
    allowDelegate: true, spoolPath: path.join(home, "spool"),
    runDelegate: () => assert.fail("unexpected delivery"),
  };
}

const session = { pid: 1000, sessionId: "session-a", name: "worker", messagingSocketPath: "endpoint" };

test("failed dry runs leave the spool untouched", async (t) => {
  const opts = fixture(t, []);
  const result = await sendMessage({ ...opts, dryRun: true });
  assert.equal(result.cause, "target_not_found");
  assert.equal(fs.existsSync(opts.spoolPath), false);
});

test("a raw ID cannot authorize delivery to an unusable or ambiguous provider name", async (t) => {
  for (const sessions of [
    [{ ...session, name: null }], [{ ...session, messagingSocketPath: null }],
    [session, { ...session, pid: 1001, sessionId: "session-b" }],
  ]) {
    const result = await sendMessage(fixture(t, sessions));
    assert.equal(result.cause, "target_not_addressable");
  }
});

test("an ID that changes between lookup and delegate dispatch is refused", async (t) => {
  const opts = fixture(t, [session]);
  let reads = 0;
  const result = await sendMessage({
    ...opts,
    readFile: () => JSON.stringify(++reads === 1 ? session : { ...session, sessionId: "session-b" }),
  });
  assert.equal(reads, 2);
  assert.equal(result.cause, "target_not_addressable");
});
