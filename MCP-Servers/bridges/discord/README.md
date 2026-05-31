# Discord MCP Bridge

Local stdio MCP bridge for Discord guild, channel, and message operations using a Discord bot token.

## Requirements

- Node.js 18 or newer.
- A Discord application with a bot user.
- The bot installed into each target server with the least permissions needed for your workflow.

## Discord Setup

1. Open the Discord Developer Portal: https://discord.com/developers/applications
2. Create or open an application.
3. Open the Bot page and reset/copy the bot token.
4. Store the token through the AI-Tools installer. Do not commit it.
5. Open Installation or OAuth2 settings and create a server install link with the `bot` scope.
6. Grant only the permissions the bridge needs:
   - View Channels
   - Read Message History
   - Send Messages, only if `discord_send_message` is needed
7. Install the bot into the target server.
8. Optionally set `DISCORD_ALLOWED_GUILD_IDS` to a comma-separated list of server IDs. This keeps guild-scoped tools from reading or writing outside the allowlist.

## Message Content

Discord can omit message content for bots that do not have the privileged Message Content intent and matching channel permissions. The bridge still returns the API response, but `discord_get_channel_messages` adds a warning when messages are present with empty content and no embeds or attachments.

Only enable the Message Content intent if your use case needs message text. Keep the bridge configured with the narrowest server/channel permissions that satisfy the workflow.

## Tools

- `connection_info`: show authenticated bot identity and the configured guild allowlist.
- `discord_list_guilds`: list guilds the bot belongs to and mark allowlist status.
- `discord_get_guild_channels`: list channels in one guild.
- `discord_get_channel`: get one channel by ID.
- `discord_get_channel_messages`: read recent channel messages.
- `discord_send_message`: send a channel message.

`discord_send_message` suppresses mentions by default with `allowed_mentions: { "parse": [] }`. Set `allowMentions: true` and pass `allowedMentionsJson` only when mention parsing is intentional.

## Installer Fields

- `DISCORD_BOT_TOKEN`: required secret. Stored in `.mcp.local.json`.
- `DISCORD_ALLOWED_GUILD_IDS`: optional public allowlist. Stored in `.mcp.json`.

## Verification

Run local tests:

```powershell
cd MCP-Servers/bridges/discord
npm test
npm audit --omit=dev --audit-level=moderate
```

Validate credentials through the installer:

```powershell
node Installers/MCP-Suite/Scripts/install.mjs --workspace=D:/tmp/discord-live-smoke --bridges=discord --non-interactive --field=DISCORD_BOT_TOKEN=$env:DISCORD_BOT_TOKEN
```

## References

- Discord OAuth2 and permissions: https://docs.discord.com/developers/platform/oauth2-and-permissions
- Discord bot setup: https://docs.discord.com/developers/quick-start/getting-started
- Discord rate limits: https://docs.discord.com/developers/topics/rate-limits
