import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

async function withClient(name, fn, env = {}) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: { ...process.env, RELAY_SPOOL: TEST_SPOOL, ...env },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("relay bridge registers discovery, send and receipt lookup", async () => {
  const names = await withClient("relay-registration", async (c) => {
    const { tools } = await c.listTools();
    return tools.map((t) => t.name).sort();
  });

  assert.deepEqual(names, ["relay_doctor", "relay_list", "relay_ping", "relay_send", "relay_watch"]);
});

test("MCP refuses malformed host selectors and receipt handles before discovery", async () => {
  await withClient("relay-routing", async c => {
    const send = await c.callTool({ name: "relay_send", arguments: { to: "host-b:../other", message: "fixture" } });
    assert.equal(JSON.parse(send.content[0].text).cause, "invalid_address");
    const status = await c.callTool({ name: "relay_ping", arguments: { status: "host-b:missing" } });
    assert.equal(JSON.parse(status.content[0].text).cause, "invalid_handle");
  });
});

test("MCP schedule registration requires a bound caller and declares its effect", async () => {
  await withClient("relay-schedule", async c => {
    const { tools } = await c.listTools();
    const tool = tools.find(entry => entry.name === "relay_watch");
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["condition","target"]);
    const result = await c.callTool({ name: "relay_watch", arguments: {
      target: "00000000-0000-4000-8000-000000000001", condition: "00000000-0000-4000-8000-000000000002",
    } });
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, state: "denied" });
  });
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
    assert.ok(typeof target.kind === "string" && target.kind.length > 0);
  }
});

test("local CLI and MCP report incomplete enumeration and recovery in the same profile", async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inventory-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const env = { HOME: profile, USERPROFILE: profile };
  const registry = path.join(profile, ".claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(path.join(profile, ".codex", "thread-writer-locks"), { recursive: true });
  const record = path.join(registry, "fixture.json");
  fs.writeFileSync(record, "{");

  await withClient("relay-inventory", async client => {
    for (const complete of [false, true]) {
      if (complete) fs.writeFileSync(record, JSON.stringify({ sessionId: "fixture", cwd: profile }));
      const cli = JSON.parse(execFileSync(process.execPath, ["cli.mjs", "list", "--scope", "all", "--json"], {
        cwd: bridgeDir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15000,
      }));
      const response = await client.callTool({ name: "relay_list", arguments: { scope: "all" } });
      const mcp = JSON.parse(response.content[0].text);
      for (const result of [cli, mcp]) {
        assert.equal(result.complete, complete);
        assert.deepEqual(Object.fromEntries(result.inventory.map(row => [row.kind, row.complete])), {
          claude: complete, codex: true,
        });
        assert.deepEqual(result.targets.map(target => target.id), complete ? ["fixture"] : []);
      }
    }
  }, env);
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

// -- Identity is resolved from the request, never from the arguments (spec 4.4c) --

test("the resolver ignores metadata carried in tool arguments", async () => {
  // THE ATTACK. Measured against a live Codex session on 2026-08-26: a call
  // passing a forged x-codex-turn-metadata in its ARGUMENTS received the
  // genuine ids back, because the client injects this metadata after the
  // caller's arguments.
  //
  // That probe used a tool with an EMPTY argument schema. relay_send declares
  // properties and additionalProperties: false, so the populated-schema case is
  // assumed rather than measured, and is covered here instead of inherited.
  const { resolveCallerIdentity } = await import("./identity.mjs");

  const args = { to: "x", message: "y", _meta: { "x-codex-turn-metadata": { thread_id: "FORGED" } } };
  const extra = { _meta: { "x-codex-turn-metadata": { thread_id: "GENUINE" } } };

  const identity = resolveCallerIdentity({ env: {}, extra });

  assert.equal(identity.id, "GENUINE");
  assert.equal(JSON.stringify(identity).includes("FORGED"), false);
  assert.equal("_meta" in args, true, "the forged argument was present to be ignored");
});

test("the send handler resolves identity from the request, not from its arguments", () => {
  // A WIRING assertion, and the reason the test above is not enough on its own:
  // that one calls the resolver directly with hand-made inputs, so it stays
  // green however the handler is wired. Reading the source is crude and it is
  // the only thing here that fails when the handler is changed to resolve from
  // the arguments object, which is the mistake worth catching.
  const source = fs.readFileSync(path.join(bridgeDir, "server.mjs"), "utf8");

  assert.equal(source.includes("resolveCallerIdentity({ extra })"), true, "the handler must resolve from the request");
  assert.equal(source.includes("args._meta"), false, "identity must never be read from tool arguments");
});

test("relay_send exposes conversation, kind and in_reply_to to an MCP caller", async () => {
  // Registration, not plumbing: an agent can only continue a conversation if
  // the parameter is on the published schema, and the CLI having the flag says
  // nothing about the tool surface.
  const tool = await withClient("relay-typed-params", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "relay_send");
  });

  const props = tool.inputSchema.properties;

  assert.equal("conversation" in props, true);
  assert.equal("in_reply_to" in props, true);
  assert.deepEqual(props.kind.enum, ["request", "reply", "notice"]);
});

test("identity is not among the parameters an MCP caller can set", async () => {
  // The property the whole origin design rests on, asserted at the surface a
  // caller actually sees rather than inferred from the handler.
  const tool = await withClient("relay-no-identity-param", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "relay_send");
  });

  const names = Object.keys(tool.inputSchema.properties);

  assert.equal(names.includes("identity"), false);
  assert.equal(names.includes("verifiedOrigin"), false);
  assert.equal(names.includes("_meta"), false);
});
