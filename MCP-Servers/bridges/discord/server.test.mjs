import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bridgeDir = dirname(fileURLToPath(import.meta.url));

test("Discord MCP server registers the expected tool surface", async () => {
  const client = new Client({ name: "discord-server-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: bridgeDir,
    env: {
      ...process.env,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_ALLOWED_GUILD_IDS: "123456789012345678",
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
        "discord_get_channel",
        "discord_get_channel_messages",
        "discord_get_guild_channels",
        "discord_list_guilds",
        "discord_send_message",
      ],
    );
  } finally {
    await client.close();
  }
});
