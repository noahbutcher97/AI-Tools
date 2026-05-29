import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

// Build a deterministic spawn env: inherit PATH etc. from process.env, then
// explicitly DELETE the perforce-relevant vars the developer might have set
// locally (P4PASSWD, PROJECT_ROOT) so the test exercises the resolver's
// required-vs-optional gating regardless of host shell state, then set only
// the fields the test cares about.
function buildSpawnEnv() {
  const env = { ...process.env };
  // P4PASSWD intentionally absent — required:false in the manifest. Tests
  // the resolver fix in lib/resolve-config.mjs: tier-1 envHasAll must NOT
  // gate on optional fields, only required ones.
  delete env.P4PASSWD;
  // PROJECT_ROOT would force tier 2 file lookup and bypass the tier-1 check
  // we're testing.
  delete env.PROJECT_ROOT;
  env.P4PORT = "invalid:1666";
  env.P4USER = "test-user";
  env.P4CLIENT = "test-client";
  env.P4DEPOT = "Project/Depot";
  return env;
}

test("Perforce MCP server registers changelist and move tools", async () => {
  const client = new Client({ name: "perforce-server-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: buildSpawnEnv(),
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
    assert.ok(toolNames.includes("p4_reopen"));
    assert.ok(toolNames.includes("p4_move"));
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
    assert.ok(toolNames.includes("p4_users"));
    assert.ok(toolNames.includes("p4_groups"));
    assert.ok(toolNames.includes("p4_group_info"));
    assert.ok(toolNames.includes("p4_login_status"));
    assert.ok(toolNames.includes("p4_protects"));
  } finally {
    await client.close();
  }
});
