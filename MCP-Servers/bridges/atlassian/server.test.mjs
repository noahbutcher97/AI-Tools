import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

// Registration smoke tests, matching the perforce/otter/discord pattern. This
// bridge is loaded BY PATH by live workspaces with no version pin, so a typo in
// a tool definition would otherwise surface in someone's session rather than in
// CI. Credentials are deliberately bogus: the server must still register its
// tools, and nothing here contacts Atlassian.
function buildSpawnEnv() {
  const env = { ...process.env };
  delete env.PROJECT_ROOT;
  env.ATLASSIAN_SITE_NAME = "example";
  env.ATLASSIAN_USER_EMAIL = "test@example.com";
  env.ATLASSIAN_API_TOKEN = "not-a-real-token";
  return env;
}

async function withClient(name, fn) {
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
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("atlassian bridge registers its Jira and Confluence tools", async () => {
  const names = await withClient("atlassian-registration", async (c) => {
    const { tools } = await c.listTools();
    return tools.map((t) => t.name);
  });

  for (const expected of [
    "connection_info",
    "jira_search",
    "jira_get_issue",
    "jira_request",
    "confluence_get_page",
    "confluence_search",
    "confluence_space_pages",
    "confluence_list_spaces",
    "confluence_request",
  ]) {
    assert.ok(names.includes(expected), `${expected} should be registered`);
  }
});

test("jira_validate_keys is registered and takes a key list", async () => {
  const tool = await withClient("atlassian-validate-keys", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "jira_validate_keys");
  });

  assert.ok(tool, "jira_validate_keys should be registered");
  const props = Object.keys(tool.inputSchema.properties ?? {});
  assert.ok(props.includes("keys"), "must accept a batch of keys");
  assert.ok(props.includes("checkSearchable"), "must expose the searchability check");
});

test("jira_get_links is registered and can verify link targets", async () => {
  const tool = await withClient("atlassian-get-links", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "jira_get_links");
  });

  assert.ok(tool, "jira_get_links should be registered");
  const props = Object.keys(tool.inputSchema.properties ?? {});
  assert.ok(props.includes("issueKeys"));
  assert.ok(props.includes("checkTargets"), "dangling detection must be reachable");
});

test("confluence_get_page exposes text output and historical versions", async () => {
  const tool = await withClient("atlassian-get-page", async (c) => {
    const { tools } = await c.listTools();
    return tools.find((t) => t.name === "confluence_get_page");
  });

  const props = Object.keys(tool.inputSchema.properties ?? {});
  assert.ok(props.includes("format"), "large pages must be readable as text");
  assert.ok(props.includes("version"), "historical versions must be fetchable");
});

test("the paginating Confluence listings expose start", async () => {
  const tools = await withClient("atlassian-pagination", async (c) => {
    const { tools } = await c.listTools();
    return tools;
  });

  for (const name of ["confluence_space_pages", "confluence_list_spaces", "confluence_search"]) {
    const props = Object.keys(tools.find((t) => t.name === name).inputSchema.properties ?? {});
    assert.ok(props.includes("start"), `${name} must be pageable to completion`);
  }
});
