import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

// Registration smoke tests, matching the atlassian/perforce pattern. This
// bridge is loaded BY PATH from Codex's config.toml with no version pin, so a
// typo in a tool definition would surface in someone's live session rather than
// here. Nothing in these tests sends anything.
// A throwaway spool, so a test run can never append to the operator's real one
// at ~/.cross-agent-relay/spool.log.
const TEST_SPOOL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-server-")), "spool.log");

async function withClient(name, fn) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: { ...process.env, RELAY_SPOOL: TEST_SPOOL },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("relay bridge registers its list and send tools", async () => {
  const names = await withClient("relay-registration", async (c) => {
    const { tools } = await c.listTools();
    return tools.map((t) => t.name).sort();
  });

  assert.deepEqual(names, ["relay_list", "relay_send"]);
});

test("relay_list declares itself read-only so a host can auto-approve it", async () => {
  // Measured from a real Codex session: a tool with no readOnlyHint is treated
  // as side-effecting, and under `approval_policy = "never"` the call FAILS
  // rather than prompting. relay_list only reads registries, so the annotation
  // is both true and the difference between usable and unusable.
  const tool = await withClient("relay-annotations", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "relay_list");
  });

  assert.equal(tool.annotations?.readOnlyHint, true);
});

test("relay_send does not claim to be read-only", async () => {
  // It queues a message into another agent's session. Annotating it read-only
  // to dodge an approval prompt would be a lie told to the host's safety layer.
  const tool = await withClient("relay-annotations-send", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "relay_send");
  });

  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, false);
});

test("relay bridge does not expose a read or spool-draining tool yet", async () => {
  // The read layer is Unit 4, and the spool is never agent-drained (spec 2, 6).
  // A tool appearing here early is how either discipline would quietly lapse.
  const names = await withClient("relay-surface", async (c) => {
    const { tools } = await c.listTools();
    return tools.map((t) => t.name);
  });

  assert.deepEqual(
    names.filter((n) => /read|summary|spool|drain|retry/i.test(n)),
    [],
  );
});

test("relay_list answers against the live machine without being told a scope", async () => {
  const payload = await withClient("relay-list", async (c) => {
    const result = await c.callTool({ name: "relay_list", arguments: { scope: "all" } });
    return JSON.parse(result.content[0].text);
  });

  assert.equal(Array.isArray(payload.targets), true);
  assert.equal(Array.isArray(payload.warnings), true);
  // A listing that does not say it is a snapshot invites a caller to hold it.
  assert.match(payload.note, /re-list/i);
});

test("every listed target states whether it can be sent to", async () => {
  const targets = await withClient("relay-list-shape", async (c) => {
    const result = await c.callTool({ name: "relay_list", arguments: { scope: "all" } });
    return JSON.parse(result.content[0].text).targets;
  });

  for (const target of targets) {
    assert.equal(typeof target.addressable, "boolean", `${target.id} has no addressable flag`);
    assert.equal(["claude", "codex"].includes(target.kind), true);
  }
});

test("relay_send refuses an unknown target without delivering anything", async () => {
  const payload = await withClient("relay-send-refusal", async (c) => {
    const result = await c.callTool({
      name: "relay_send",
      arguments: { to: "01a09999-0000-7000-a000-000000000000", message: "registration test, never delivered" },
    });
    return JSON.parse(result.content[0].text);
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.cause, "target_not_found");
  // The refusal spooled, and it spooled to the throwaway path rather than the
  // operator's real one.
  assert.equal(payload.spooled, TEST_SPOOL);
});

test("relay_send requires a non-empty message", async () => {
  await withClient("relay-send-validation", async (c) => {
    const result = await c.callTool({ name: "relay_send", arguments: { to: "someone", message: "" } });
    assert.equal(result.isError, true);
  });
});
