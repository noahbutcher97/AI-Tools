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
function buildSpawnEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.PROJECT_ROOT;
  delete env.ATLASSIAN_FILE_ROOTS;
  env.ATLASSIAN_SITE_NAME = "example";
  env.ATLASSIAN_USER_EMAIL = "test@example.com";
  env.ATLASSIAN_API_TOKEN = "not-a-real-token";
  return { ...env, ...overrides };
}

async function withClient(name, fn, envOverrides = {}) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: buildSpawnEnv(envOverrides),
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
    "jira_read_issue",
    "jira_list_comments",
    "jira_list_attachments",
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

test("the additive Jira read tools expose raw fields and explicit page coverage", async () => {
  const tools = await withClient("atlassian-detailed-reads", async (c) => {
    const result = await c.listTools();
    return result.tools;
  });

  const readIssue = tools.find((tool) => tool.name === "jira_read_issue");
  assert.deepEqual(readIssue.inputSchema.required.sort(), ["fields", "issueKey"]);
  const comments = tools.find((tool) => tool.name === "jira_list_comments");
  assert.ok(comments.inputSchema.properties.startAt);
  assert.ok(comments.inputSchema.properties.maxResults);
});

test("attachment transfer tools are unavailable until absolute file roots are configured", async () => {
  const withoutRoots = await withClient("atlassian-no-file-roots", async (c) => {
    const { tools } = await c.listTools();
    return tools.map((tool) => tool.name);
  });
  assert.ok(!withoutRoots.includes("jira_upload_attachment"));
  assert.ok(!withoutRoots.includes("jira_download_attachment"));

  const withRoots = await withClient("atlassian-with-file-roots", async (c) => {
    const { tools } = await c.listTools();
    return tools;
  }, { ATLASSIAN_FILE_ROOTS: JSON.stringify([bridgeDir]) });
  for (const name of ["jira_upload_attachment", "jira_download_attachment"]) {
    const tool = withRoots.find((item) => item.name === name);
    assert.ok(tool, `${name} should be registered with valid roots`);
    assert.deepEqual(
      tool.inputSchema.required.sort(),
      name === "jira_upload_attachment"
        ? ["expectedSha256", "filePath", "issueKey", "maxBytes"]
        : ["attachmentId", "destinationPath", "expectedSha256", "maxBytes"],
    );
  }
});

test("malformed or empty file-root JSON leaves attachment transfer tools unavailable", async (t) => {
  for (const [name, value] of [["malformed", "not-json"], ["empty", "[]"], ["relative", '["relative"]']]) {
    await t.test(name, async () => {
      const names = await withClient(`atlassian-roots-${name}`, async (c) => {
        const { tools } = await c.listTools();
        return tools.map((tool) => tool.name);
      }, { ATLASSIAN_FILE_ROOTS: value });
      assert.ok(!names.includes("jira_upload_attachment"));
      assert.ok(!names.includes("jira_download_attachment"));
      assert.ok(names.includes("jira_read_issue"));
    });
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
