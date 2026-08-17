import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

// Registration smoke tests, matching the perforce/otter/discord pattern. This
// bridge is loaded BY PATH by a live workspace with no version pin, so a typo in
// a tool definition would otherwise surface in someone's session rather than in
// CI. The token is deliberately bogus; nothing here contacts Miro.
function buildSpawnEnv() {
  const env = { ...process.env };
  delete env.PROJECT_ROOT;
  env.MIRO_ACCESS_TOKEN = "not-a-real-token";
  env.MIRO_ORG_NAME = "test-org";
  return env;
}

async function withTools(name, fn) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: buildSpawnEnv(),
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return await fn(tools);
  } finally {
    await client.close();
  }
}

test("miro bridge registers its board and item tools", async () => {
  const names = await withTools("miro-registration", (tools) => tools.map((t) => t.name));

  for (const expected of [
    "connection_info",
    "miro_list_boards",
    "miro_get_board",
    "miro_get_board_items",
    "miro_get_item",
    "miro_get_connectors",
  ]) {
    assert.ok(names.includes(expected), `${expected} should be registered`);
  }
});

test("miro_request is registered as a generic escape hatch", async () => {
  const tool = await withTools("miro-request", (tools) => tools.find((t) => t.name === "miro_request"));

  assert.ok(tool, "miro_request should be registered");
  const props = Object.keys(tool.inputSchema.properties ?? {});
  for (const p of ["path", "method", "queryParams", "bodyJson"]) {
    assert.ok(props.includes(p), `miro_request must accept ${p}`);
  }
});

test("miro_get_connectors can resolve its endpoints", async () => {
  // Without this the dependency graph is bare IDs and has to be joined by hand.
  const tool = await withTools("miro-connectors", (tools) => tools.find((t) => t.name === "miro_get_connectors"));

  const props = Object.keys(tool.inputSchema.properties ?? {});
  assert.ok(props.includes("resolveEndpoints"), "endpoints must be resolvable in one call");
});

test("miro_get_all_board_items is registered and bounds its own paging", async () => {
  const tool = await withTools("miro-all-items", (tools) => tools.find((t) => t.name === "miro_get_all_board_items"));

  assert.ok(tool, "miro_get_all_board_items should be registered");
  const props = Object.keys(tool.inputSchema.properties ?? {});
  assert.ok(props.includes("maxPages"), "a whole-board sweep must be bounded");
});
