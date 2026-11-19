import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as relay from "./client.mjs";

test("only an explicitly referenced conversational record from the selected Claude session can be quoted", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const opts = { to: id, claudeSessionsDir: path.join(root, "registry"), claudeProjectsDir: path.join(root, "projects"), codexHome: root };
  fs.mkdirSync(opts.claudeSessionsDir);
  fs.writeFileSync(path.join(opts.claudeSessionsDir, "1000.json"), JSON.stringify({ pid: 1000, sessionId: id,
    name: "fixture", cwd: "fixture", status: "idle", messagingSocketPath: "fixture", entrypoint: "cli" }));
  const folder = path.join(opts.claudeProjectsDir, "fixture");
  fs.mkdirSync(folder, { recursive: true });
  const record = { type: "assistant", sessionId: id, message: { role: "assistant", content: "x".repeat(300) } };
  const rows = [{ ...record, uuid: "side", isSidechain: true }, { ...record, uuid: "wrong", sessionId: other },
    { ...record, uuid: "metadata", isMeta: true }, { ...record, uuid: "tool", message: { role: "assistant",
      content: [{ type: "tool_use", name: "fixture" }] } }, { ...record, uuid: "quoted" }];
  fs.writeFileSync(path.join(folder, id + ".jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  for (const re of ["side", "wrong", "tool", "metadata", "missing"]) assert.equal((await relay.resolveReference({ ...opts, re })).ok, false);
  const quote = await relay.resolveReference({ ...opts, re: "quoted", excerptLimit: 999 });
  assert.equal(quote.excerpt, "x".repeat(280));
  assert.equal(quote.truncated, true);
  assert.equal("readTranscript" in relay, false);
  assert.equal("summarizeTarget" in relay, false);
  let count = 0;
  const sent = await relay.sendMessage({ ...opts, re: "quoted", message: "notice", allowDelegate: true,
    runDelegate: async invocation => {
      count++;
      assert.match(invocation.delivered, /"turn":"quoted"/);
      assert.ok(invocation.delivered.includes(quote.excerpt));
      return { code: 0, stdout: "RELAY-OK" };
    } });
  assert.equal(sent.ok, true);
  assert.equal(count, 1);
});
