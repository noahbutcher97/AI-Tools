import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

test("Perforce MCP server registers changelist and move tools", async () => {
  const client = new Client({ name: "perforce-server-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: {
      ...process.env,
      P4PORT: "invalid:1666",
      P4USER: "test-user",
      P4CLIENT: "test-client",
      P4DEPOT: "Project/Depot",
      // P4PASSWD is optional in the manifest but resolveBridgeConfig's tier-1
      // env check currently requires every field — including optional ones —
      // for "envHasAll" to succeed. Without this the server exits on startup
      // in environments lacking a .mcp.json (e.g. fresh CI runners), and the
      // MCP client reports a misleading "Connection closed" error. The auto-
      // login try/catch in server.mjs swallows the inevitable `p4 login`
      // failure against invalid:1666, so this is safe.
      P4PASSWD: "test-pass",
    },
    stderr: "pipe",
  });

  await client.connect(transport);
  try {
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("p4_create_changelist"));
    assert.ok(toolNames.includes("p4_update_changelist"));
    assert.ok(toolNames.includes("p4_delete_changelist"));
    assert.ok(toolNames.includes("p4_edit"));
    assert.ok(toolNames.includes("p4_add"));
    assert.ok(toolNames.includes("p4_delete"));
    assert.ok(toolNames.includes("p4_revert"));
    assert.ok(toolNames.includes("p4_lock"));
    assert.ok(toolNames.includes("p4_unlock"));
    assert.ok(toolNames.includes("p4_move_opened_files"));
    assert.ok(toolNames.includes("p4_move_file"));
    assert.ok(toolNames.includes("p4_submit"));
    assert.ok(toolNames.includes("p4_shelve"));
    assert.ok(toolNames.includes("p4_unshelve"));
    assert.ok(toolNames.includes("p4_integrate"));
    assert.ok(toolNames.includes("p4_merge"));
    assert.ok(toolNames.includes("p4_copy"));
    assert.ok(toolNames.includes("p4_print"));
    assert.ok(toolNames.includes("p4_annotate"));
    assert.ok(toolNames.includes("p4_where"));
    assert.ok(toolNames.includes("p4_have"));
  } finally {
    await client.close();
  }
});
