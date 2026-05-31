import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { z } from "zod/v3";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";
import { toolErrorResult, toolJsonResult } from "../../lib/tool-result.mjs";
import { OtterClient } from "./client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf-8"));
loadBridgeConfigOrExit("otter", manifest.fields);

const otter = new OtterClient({ apiKey: process.env.OTTER_API_KEY });
const server = new McpServer({
  name: "otter-bridge",
  version: "1.0.0",
  description: "Otter.ai bridge for Enterprise Public API meeting data.",
});

function runJson(fn) {
  return async (args) => {
    try {
      return toolJsonResult(await fn(args || {}));
    } catch (e) {
      return toolErrorResult(e?.message || String(e));
    }
  };
}

server.tool(
  "connection_info",
  "Show the authenticated Otter workspace.",
  {},
  runJson(async () => {
    const workspace = await otter.getWorkspace();
    return {
      workspace: workspace.data || workspace,
      credentialSource: process.env.PROJECT_ROOT ? "PROJECT_ROOT/env" : "env",
    };
  }),
);

server.tool(
  "otter_get_workspace",
  "Get the authenticated Otter workspace details.",
  {},
  runJson(async () => await otter.getWorkspace()),
);

server.tool(
  "otter_list_channels",
  "List Otter channels for the authenticated user.",
  {},
  runJson(async () => await otter.listChannels()),
);

server.tool(
  "otter_get_channel_members",
  "List members in a specific Otter channel.",
  {
    channelId: z.string().describe("Otter channel ID."),
  },
  runJson(async ({ channelId }) => await otter.getChannelMembers(channelId)),
);

server.tool(
  "otter_list_conversations",
  "List Otter conversations using cursor pagination. channelId scopes to one channel; includeShared without channelId may cross conversation boundaries.",
  {
    includeShared: z.boolean().optional().default(false).describe("Include conversations shared with the authenticated user."),
    channelId: z.string().optional().describe("Filter conversations by Otter channel ID. Automatically includes shared conversations for that channel."),
    limit: z.number().optional().default(20).describe("Page size, 1-100."),
    cursor: z.string().optional().describe("Cursor from meta.next_cursor."),
  },
  runJson(async ({ includeShared, channelId, limit, cursor }) => {
    const result = await otter.listConversations({ includeShared, channelId, limit, cursor });
    const scope = channelId
      ? `channel: ${channelId}`
      : includeShared
        ? "OWN_AND_SHARED_CONVERSATIONS"
        : "OWN_CONVERSATIONS";
    return {
      scope,
      warning: !channelId && includeShared
        ? "includeShared=true without channelId may return conversations shared from across the authenticated user's Otter workspace access."
        : null,
      ...result,
    };
  }),
);

server.tool(
  "otter_get_conversation",
  "Get one Otter conversation with selected relationships such as transcript, action items, insights, or outline.",
  {
    conversationId: z.string().describe("Otter conversation ID."),
    include: z.string().optional().describe("Comma-separated include values: action_items, insights, outline, transcript, all."),
  },
  runJson(async ({ conversationId, include }) => await otter.getConversation(conversationId, include)),
);

server.tool(
  "otter_get_conversation_audio",
  "Get the MP3 audio download link for one Otter conversation.",
  {
    conversationId: z.string().describe("Otter conversation ID."),
  },
  runJson(async ({ conversationId }) => await otter.getConversationAudio(conversationId)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[otter-bridge] MCP server running");
