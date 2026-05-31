import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

test("Otter MCP server registers the expected tool surface", async () => {
  const client = new Client({ name: "otter-server-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: {
      ...process.env,
      OTTER_API_KEY: "test-key",
    },
    stderr: "pipe",
  });

  await client.connect(transport);
  try {
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      [
        "connection_info",
        "otter_get_channel_members",
        "otter_get_conversation",
        "otter_get_conversation_audio",
        "otter_get_workspace",
        "otter_list_channels",
        "otter_list_conversations",
      ],
    );
  } finally {
    await client.close();
  }
});
