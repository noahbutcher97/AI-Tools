import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { parseArgs } from "./client.mjs";
import { addIndexedSession } from "./fixtures/session-index.mjs";

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

function profileNodeArgs(env) {
  // Leave the real installed settings untouched on either platform.
  if (!env.USERPROFILE) return [];
  const loader = new URL("../../../Installers/CrossAgentRelay/fixtures/local-inventory-loader.mjs", import.meta.url);
  return ["--no-warnings", "--experimental-loader", loader.href];
}

async function withClient(name, fn, env = {}) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...profileNodeArgs(env), "server.mjs"],
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

  assert.deepEqual(names, ["relay_doctor", "relay_list", "relay_ping", "relay_resolve", "relay_send", "relay_watch"]);
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

test("resolve rejects extra options, repeated selectors and missing values", () => {
  for (const args of [
    [], ["--host", "fixture"], ["--id="], ["--id", "--adapter", "fixture"],
    ["--id=a", "--id", "b"], ["--id=a", "--adapter=x", "--adapter=y"],
    ["--id=a", "--host=x", "--host=y"], ["--id=a", "--json", "--json"],
    ["--id=a", "--json=false"], ["--id=a", "--all-hosts"], ["--id=a", "b"],
  ]) assert.throws(() => parseArgs(["resolve", ...args]), Error);
  assert.deepEqual(parseArgs(["resolve", "--id=--id=x", "--adapter", "fixture", "--host=local", "--json"]), {
    command: "resolve", selector: { id: "--id=x", adapter: "fixture", host: "local" }, json: true,
  });
});

test("send and ping accept a literal local selector and keep positional addresses separate", () => {
  const id = '--Sample:Group/Case="A"';
  for (const command of ["send", "ping"]) {
    const options = parseArgs([command, "--adapter", "sample", `--id=${id}`, "--host=desk", "--json"]);
    assert.deepEqual(options.selector, { id, adapter: "sample", host: "desk" });
    assert.equal(options.to, undefined);
    assert.equal(options.viaDelegate, false);
    assert.equal(parseArgs([command, "--via-delegate", `--id=${id}`]).viaDelegate, true);
    for (const address of ["raw-session", "desk:raw-session"]) {
      assert.equal(parseArgs([command, address]).to, address);
    }
    for (const args of [
      ["positional", "--id=a"], ["--id=a", "positional"], ["positional", "--host=desk"],
      ["--adapter=sample"], ["--host=desk"], ["--id=a", "--id=b"], ["--id", "--adapter", "sample"],
      ["--id=a", "--adapter=x", "--adapter=x"], ["--id=a", "--host=x", "--host=y"],
      ["--id=a", "--status", "s"], ["--id=a", "--all-hosts"], ["--id=a", "--request-id", "s"],
      ["--id=a", "--json", "--json"], ["--id=a", "--scope", "all"], ["--id=a", "--cwd", "work"],
      ["--id="], ["--id=a\n"], ["--id=a", "--host=../peer"], ["--id=a", "--adapter=../reader"],
    ]) assert.throws(() => parseArgs([command, ...args]), Error, `${command} ${args.join(" ")}`);
  }
  const send = parseArgs(["send", `--id=${id}`, "--dry-run", "--message", "one\ntwo", "--re", "turn",
    "--from", "operator", "--kind", "reply", "--conversation", "conversation", "--in-reply-to", "message"]);
  assert.equal(send.dryRun, true);
  assert.equal(send.message, "one\ntwo");
  assert.deepEqual([send.re, send.from, send.kind, send.conversation, send.inReplyTo],
    ["turn", "operator", "reply", "conversation", "message"]);
  assert.equal(parseArgs(["send", `--id=${id}`]).message, undefined);
});

test("CLI refuses conflicting send modes while its stdin remains open", async t => {
  const child = spawn(process.execPath, ["cli.mjs", "send", "positional", "--id=literal"], {
    cwd: bridgeDir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI waited for input")); }, 10000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(code, 2, stderr);
  assert.match(stderr, /--id/);
});

test("MCP send and ping refuse mixed selectors and unknown fields before delivery", async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mode-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const spool = path.join(profile, "spool.log");
  await withClient("relay-mode", async client => {
    for (const name of ["relay_send", "relay_ping"]) {
      const tool = (await client.listTools()).tools.find(tool => tool.name === name);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.readOnlyHint, false);
      for (const key of ["id", "adapter", "host"]) assert.ok(tool.inputSchema.properties[key]);
      const legacy = name === "relay_send" ? "to" : "target";
      const base = name === "relay_send" ? { message: "fixture", dry_run: true } : {};
      const mixed = [{}, { adapter: "fixture" }, { [legacy]: "old", id: "new" }, { [legacy]: "old", host: "desk" }];
      if (name === "relay_send") mixed.push({ id: "literal", request_id: "remote" });
      else mixed.push({ id: "literal", status: "receipt" }, { id: "literal", all_hosts: true }, { status: "receipt", adapter: "fixture" });
      for (const args of mixed) {
        const response = await client.callTool({ name, arguments: { ...base, ...args } });
        assert.equal(response.isError, true);
        assert.equal(JSON.parse(response.content[0].text).cause, name === "relay_send" ? "invalid_send_mode" : "invalid_ping_mode");
      }
      for (const fields of [{ id: "literal", unexpected: true }, { id: "" }, { id: "literal", adapter: 1 },
        { id: "literal", [name === "relay_send" ? "target" : "to"]: "old" }]) {
        const response = await client.callTool({ name, arguments: { ...base, ...fields } });
        assert.equal(response.isError, true);
        assert.match(response.content[0].text, /validation/i);
      }
    }
  }, { HOME: profile, USERPROFILE: profile, RELAY_SPOOL: spool });
  assert.equal(fs.existsSync(spool), false);
});

test("a dry-run through the CLI and MCP checks the indexed Codex fixture without a queue executable", async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return t.skip("node:sqlite unavailable"); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dry-run-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const id = "019af000-0000-7000-8000-000000000001";
  const codex = path.join(profile, ".codex");
  fs.mkdirSync(path.join(codex, "thread-writer-locks"), { recursive: true });
  fs.writeFileSync(path.join(codex, "thread-writer-locks", id + ".lock"), "");
  addIndexedSession(DatabaseSync, codex, id, profile);
  const env = { HOME: profile, USERPROFILE: profile, ProgramFiles: profile, PATH: profile, RELAY_SPOOL: path.join(profile, "spool.log") };
  const cli = spawnSync(process.execPath, [...profileNodeArgs(env), "cli.mjs", "send",
    "--id", id, "--adapter", "codex", "--dry-run", "--json"], {
    cwd: bridgeDir, env: { ...process.env, ...env }, input: "first line\nsecond line", encoding: "utf8", timeout: 15000,
  });
  assert.equal(cli.status, 0, cli.error?.message || cli.stderr || cli.stdout);
  await withClient("relay-local-dry-run", async client => {
    const mcp = await client.callTool({ name: "relay_send", arguments: {
      id, adapter: "codex", message: "first line\nsecond line", dry_run: true,
    } });
    for (const result of [JSON.parse(cli.stdout), JSON.parse(mcp.content[0].text)]) {
      assert.equal(result.ok, true);
      assert.equal(result.state, "eligible");
      assert.equal(result.dispatch, "not_submitted");
      assert.deepEqual(result.binding, { id, adapter: "codex", host: null });
    }
  }, env);
  assert.equal(fs.existsSync(env.RELAY_SPOOL), false);
  assert.equal(fs.existsSync(path.join(profile, ".cross-agent-relay")), false);
});

test("CLI and MCP discover and resolve the same literal local address and report refusals", async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-address-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const env = { HOME: profile, USERPROFILE: profile };
  const registry = path.join(profile, ".claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(path.join(profile, ".codex", "thread-writer-locks"), { recursive: true });
  const id = '--Client:Group/Case="A"';
  const record = JSON.stringify({ sessionId: id, name: "display-name", cwd: profile });
  fs.writeFileSync(path.join(registry, "first.json"), record);
  const cli = (...args) => {
    const run = spawnSync(process.execPath, [...profileNodeArgs(env), "cli.mjs", ...args], {
      cwd: bridgeDir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15000,
    });
    if (run.error) throw run.error;
    return run;
  };
  const help = cli("resolve", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--id=VALUE/);
  assert.match(help.stdout, /list --scope all --json/);
  assert.equal(cli("resolve", "--id", id).status, 2);

  await withClient("relay-address", async client => {
    const tool = (await client.listTools()).tools.find(entry => entry.name === "relay_resolve");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(tool.inputSchema.required, ["id"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const args of [{ adapter: "claude" }, { id, all_hosts: true }, { id, adapter: 1 }]) {
      const response = await client.callTool({ name: tool.name, arguments: args });
      assert.equal(response.isError, true);
    }
    const listed = cli("list", "--scope", "all", "--json");
    assert.equal(listed.status, 0, listed.stderr);
    const row = JSON.parse(listed.stdout).targets[0];
    assert.equal(row.id, id);
    assert.equal(row.kind, "claude");
    async function check(selector, state) {
      const args = ["resolve", `--id=${selector.id}`, "--json"];
      if (selector.adapter) args.push("--adapter", selector.adapter);
      if (selector.host) args.push("--host", selector.host);
      const run = cli(...args);
      const resolved = state === "resolved";
      assert.equal(run.status, resolved ? 0 : 1, run.stderr || run.stdout);
      const result = JSON.parse(run.stdout);
      assert.equal(result.state, state);
      assert.equal(result.ok, resolved);
      const response = await client.callTool({ name: tool.name, arguments: selector });
      assert.equal(Boolean(response.isError), !resolved);
      assert.deepEqual(JSON.parse(response.content[0].text), result);
      if (resolved) {
        assert.equal(result.target.id, row.id);
        assert.equal(result.target.adapter, row.kind);
        assert.ok(Object.hasOwn(result.target, "host"));
        if (selector.host) assert.equal(result.target.host, selector.host);
      } else {
        assert.equal(result.target, undefined);
        assert.ok(result.detail);
      }
    }
    await check({ id: row.id }, "resolved");
    await check({ id: row.id, adapter: row.kind }, "resolved");
    const rendered = cli("resolve", `--id=${id}`);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(rendered.stdout.includes(JSON.stringify(id)));
    await check({ id: id.toLowerCase() }, "missing");
    await check({ id: "display-name" }, "missing");
    await check({ id, adapter: "uninstalled-reader" }, "unknown_adapter");
    await check({ id, host: "../invalid" }, "invalid_selector");
    await check({ id, host: "local-test" }, "host_unavailable");
    const install = path.join(profile, "CrossAgentRelay");
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, "machine.json"), JSON.stringify({ host: "local-test" }));
    await check({ id, host: "local-test", adapter: row.kind }, "resolved");
    await check({ id, host: "other-test" }, "nonlocal_host");

    const second = path.join(registry, "second.json");
    fs.writeFileSync(second, "{");
    await check({ id }, "incomplete_inventory");
    await check({ id, adapter: "codex" }, "missing");
    fs.writeFileSync(second, JSON.stringify({ pid: 1234, name: "legacy" }));
    assert.ok(JSON.parse(cli("list", "--scope", "all", "--json").stdout).targets.some(t => t.id === "1234"));
    await check({ id: "1234", adapter: "claude" }, "incomplete_inventory");
    await check({ id }, "incomplete_inventory");
    await check({ id: "unknown", adapter: "claude" }, "incomplete_inventory");
    fs.writeFileSync(second, record);
    await check({ id }, "ambiguous");
    await check({ id, adapter: row.kind }, "ambiguous");
    fs.unlinkSync(second);
    await check({ id }, "resolved");
    fs.writeFileSync(path.join(install, "inventory-adapters.json"), JSON.stringify({ enabled: ["codex"] }));
    const list = await client.callTool({ name: "relay_list", arguments: { scope: "all" } });
    const cliList = cli("list", "--scope", "all", "--json");
    assert.equal(cliList.status, 0, cliList.stderr);
    for (const payload of [JSON.parse(cliList.stdout), JSON.parse(list.content[0].text)]) {
      assert.deepEqual(payload.inventory, [{ kind: "codex", complete: true }]);
      assert.deepEqual(payload.targets, []);
    }
    await check({ id }, "missing");
    await check({ id, adapter: row.kind }, "unknown_adapter");
  }, env);
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
    if (target.addressable === null) assert.match(target.reason, /eligibility unchecked/);
    else assert.equal(typeof target.addressable, "boolean", `${target.id} has no addressable flag`);
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
      const cli = JSON.parse(execFileSync(process.execPath, [...profileNodeArgs(env), "cli.mjs", "list", "--scope", "all", "--json"], {
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

test("relay_send refuses an unknown target without delivering anything", async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "relay-missing-target-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  fs.mkdirSync(path.join(profile, ".claude", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(profile, ".codex", "thread-writer-locks"), { recursive: true });
  const spool = path.join(profile, "spool.log");
  const payload = await withClient("relay-send-refusal", async (c) => {
    const result = await c.callTool({
      name: "relay_send",
      arguments: { to: "01a09999-0000-7000-a000-000000000000", message: "registration test, never delivered" },
    });
    return JSON.parse(result.content[0].text);
  }, { HOME: profile, USERPROFILE: profile, RELAY_FIXTURE_ROOT: "", RELAY_SPOOL: spool });

  assert.equal(payload.ok, false);
  assert.equal(payload.cause, "target_not_found");
  // The refusal spooled, and it spooled to the throwaway path rather than the
  // operator's real one.
  assert.equal(payload.spooled, spool);
  assert.ok(fs.readFileSync(spool, "utf8").includes("registration test, never delivered"));
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
