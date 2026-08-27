import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultSpoolPath, fallbackSpoolPath, sendMessage } from "./client.mjs";

// Never append to the operator's real ledger: a test run would consume real
// quota, and later runs would fail on caps filled by earlier ones.
process.env.RELAY_LEDGER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-ledger-")), "ledger.log");


// The spool is deliberately outside the repository so message bodies never land
// in git. Measured 2026-08-24: that also puts it outside Codex's workspace-write
// sandbox, so a relay invoked from a Codex shell command cannot write it —
// EPERM on ~/.cross-agent-relay/spool.log.
//
// The failure lands exactly where the spool exists to help: a send that failed,
// from the agent least able to retry it. So an unwritable spool must fall back
// rather than lose the message, and must say where the message actually went.

const NOW = 1787507400000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-spool-"));
}

// A path whose parent is a FILE, so creating the directory fails the way a
// sandbox denial does.
function unwritableSpoolPath() {
  const dir = tmpdir();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  return path.join(blocker, "nested", "spool.log");
}

function failingSend(extra = {}) {
  return sendMessage({
    to: "01a09999-0000-7000-a000-000000000000",
    message: "a message that must not be lost",
    claudeSessionsDir: tmpdir(),
    codexHome: tmpdir(),
    now: NOW,
    ...extra,
  });
}

test("a message is spooled to the configured path when it is writable", async () => {
  const spoolPath = path.join(tmpdir(), "spool.log");

  const result = await failingSend({ spoolPath });

  assert.equal(result.spooled, spoolPath);
  assert.match(fs.readFileSync(spoolPath, "utf8"), /must not be lost/);
});

test("an unwritable spool falls back rather than losing the message", async () => {
  // This is the Codex sandbox case. Losing the body here would break the one
  // guarantee the spool exists to provide.
  const fallback = path.join(tmpdir(), "fallback.log");

  const result = await failingSend({ spoolPath: unwritableSpoolPath(), spoolFallbackPath: fallback });

  assert.equal(result.spooled, fallback);
  assert.match(fs.readFileSync(fallback, "utf8"), /must not be lost/);
});

test("the result reports the path actually used, not the one that was attempted", async () => {
  const attempted = unwritableSpoolPath();
  const fallback = path.join(tmpdir(), "fallback.log");

  const result = await failingSend({ spoolPath: attempted, spoolFallbackPath: fallback });

  assert.notEqual(result.spooled, attempted);
  assert.equal(fs.existsSync(result.spooled), true, "the reported path does not exist");
});

test("a spool path is never reported when nothing could be written", async () => {
  // Reporting a path that holds nothing is worse than admitting the loss: it
  // tells an operator to go looking for a message that is not there.
  const result = await failingSend({
    spoolPath: unwritableSpoolPath(),
    spoolFallbackPath: unwritableSpoolPath(),
  });

  assert.equal(result.spooled, null);
  assert.equal(typeof result.spoolError, "string");
  assert.match(result.spoolError, /could not/i);
});

test("the default fallback is a temp location, not the repository", async () => {
  // The whole reason the spool sits outside the repo is that message bodies
  // must not reach git. A fallback into the working directory would undo that.
  const fallback = fallbackSpoolPath();

  assert.equal(fallback.startsWith(os.tmpdir()), true);
  assert.equal(fallback.includes(`${path.sep}MCP-Servers${path.sep}`), false);
});

test("the default and the fallback are different places", () => {
  assert.notEqual(defaultSpoolPath(), fallbackSpoolPath());
});
