import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { z } from "zod/v3";

import { loadBridgeConfigOrExit } from "../../lib/bridge-base.mjs";
import { toolErrorResult, toolJsonResult } from "../../lib/tool-result.mjs";
import { DiscordClient, parseAllowedMentionsInput } from "./client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf-8"));
loadBridgeConfigOrExit("discord", manifest.fields);

const discord = new DiscordClient({
  token: process.env.DISCORD_BOT_TOKEN,
  allowedGuildIds: process.env.DISCORD_ALLOWED_GUILD_IDS || "",
});

const allowedGuildIds = [...discord.allowedGuildIds];
const server = new McpServer({
  name: "discord-bridge",
  version: "1.0.0",
  description: "Discord bridge for guild, channel, and message operations using a bot token.",
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

function messageContentWarning(messages) {
  if (!Array.isArray(messages)) return null;
  const hasEmptyContent = messages.some((m) =>
    m && m.content === "" &&
    (!Array.isArray(m.embeds) || m.embeds.length === 0) &&
    (!Array.isArray(m.attachments) || m.attachments.length === 0)
  );
  return hasEmptyContent
    ? "One or more messages had empty content. Discord may omit message content unless the bot has the MESSAGE_CONTENT privileged intent and channel permissions."
    : null;
}

server.tool(
  "connection_info",
  "Show Discord bot identity and configured guild allowlist.",
  {},
  runJson(async () => {
    const bot = await discord.getCurrentUser();
    return {
      bot: {
        id: bot.id,
        username: bot.username,
        globalName: bot.global_name || null,
      },
      allowedGuildIds,
      credentialSource: process.env.PROJECT_ROOT ? "PROJECT_ROOT/env" : "env",
    };
  }),
);

server.tool(
  "discord_list_guilds",
  "List Discord guilds the bot belongs to. If an allowlist is configured, each guild is marked allowed or blocked.",
  {
    limit: z.number().optional().default(100).describe("Max guilds to return, 1-200."),
  },
  runJson(async ({ limit }) => {
    const guilds = await discord.listGuilds(limit);
    const hasAllowlist = discord.allowedGuildIds.size > 0;
    return {
      scope: hasAllowlist ? "ALLOWED_GUILD_IDS" : "ALL_BOT_GUILDS",
      warning: hasAllowlist ? null : "No DISCORD_ALLOWED_GUILD_IDS configured; guild listing includes every guild the bot can access.",
      guilds: guilds.map((g) => ({
        ...g,
        allowed: !hasAllowlist || discord.allowedGuildIds.has(g.id),
      })),
    };
  }),
);

server.tool(
  "discord_get_guild_channels",
  "List channels in a Discord guild. Enforces DISCORD_ALLOWED_GUILD_IDS when configured.",
  {
    guildId: z.string().describe("Discord guild/server ID."),
  },
  runJson(async ({ guildId }) => ({
    guildId,
    channels: await discord.getGuildChannels(guildId),
  })),
);

server.tool(
  "discord_get_channel",
  "Get a Discord channel by ID. Guild channels enforce DISCORD_ALLOWED_GUILD_IDS when configured.",
  {
    channelId: z.string().describe("Discord channel ID."),
  },
  runJson(async ({ channelId }) => await discord.getChannel(channelId)),
);

server.tool(
  "discord_get_channel_messages",
  "Get recent Discord channel messages. Guild channels enforce DISCORD_ALLOWED_GUILD_IDS when configured.",
  {
    channelId: z.string().describe("Discord channel ID."),
    limit: z.number().optional().default(50).describe("Max messages, 1-100."),
    before: z.string().optional().describe("Return messages before this message ID."),
    after: z.string().optional().describe("Return messages after this message ID."),
    around: z.string().optional().describe("Return messages around this message ID."),
  },
  runJson(async ({ channelId, limit, before, after, around }) => {
    const messages = await discord.getChannelMessages(channelId, { limit, before, after, around });
    const warning = messageContentWarning(messages);
    return {
      channelId,
      count: Array.isArray(messages) ? messages.length : 0,
      warning,
      messages,
    };
  }),
);

server.tool(
  "discord_send_message",
  "Send a Discord channel message. Mentions are suppressed by default unless allowMentions is true.",
  {
    channelId: z.string().describe("Discord channel ID."),
    content: z.string().min(1).describe("Message text to send."),
    allowMentions: z.boolean().optional().default(false).describe("Set true to allow mention parsing from allowedMentionsJson."),
    allowedMentionsJson: z.string().optional().describe("Optional Discord allowed_mentions JSON, only used when allowMentions is true."),
    replyToMessageId: z.string().optional().describe("Optional message ID to reply to."),
  },
  runJson(async ({ channelId, content, allowMentions, allowedMentionsJson, replyToMessageId }) => {
    return await discord.sendMessage(channelId, content, {
      allowMentions,
      allowedMentions: parseAllowedMentionsInput(allowMentions, allowedMentionsJson),
      replyToMessageId,
    });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[discord-bridge] MCP server running");
