# Otter.ai MCP Bridge

Local stdio MCP bridge for Otter.ai Enterprise Public API workspace, channel, conversation, transcript, and audio-link retrieval.

## Requirements

- Node.js 18 or newer.
- An Otter.ai Enterprise workspace with Public API access.
- An Otter API key created from the authenticated user's Integrations > Developer settings.

Otter's hosted OAuth MCP endpoint is separate from this local bridge. If a client supports remote MCP directly, the hosted endpoint is `https://mcp.otter.ai/mcp`. This repository's bridge is the installer-managed local stdio option using an Enterprise Public API key.

## Otter Setup

1. Sign in to Otter: https://otter.ai
2. Open Integrations in the left navigation.
3. Open the Developer tab.
4. Create an API key.
5. Copy and store the key immediately. Otter only shows it once.
6. Store the key through the AI-Tools installer. Do not commit it.

## API Notes

- All bridge calls use `Authorization: Bearer <OTTER_API_KEY>`.
- Otter Public API access is available for Enterprise workspaces.
- Otter documents a 10 requests per second limit for Enterprise API users.
- List endpoints use cursor pagination with `meta.has_more` and `meta.next_cursor`.
- `otter_get_conversation` requires an `include` list. The bridge defaults to `transcript,action_items,insights,outline` instead of `all` to avoid unexpectedly large payloads.

## Tools

- `connection_info`: show authenticated workspace details.
- `otter_get_workspace`: get the authenticated workspace.
- `otter_list_channels`: list channels.
- `otter_get_channel_members`: list members in one channel.
- `otter_list_conversations`: list conversations with optional channel, shared, limit, and cursor filters.
- `otter_get_conversation`: get one conversation with selected relationships.
- `otter_get_conversation_audio`: get the MP3 audio download link for one conversation.

When `otter_list_conversations` is called with `includeShared: true` and no `channelId`, the bridge returns a broad-scope warning because the result can cross channel boundaries.

## Installer Fields

- `OTTER_API_KEY`: required secret. Stored in `.mcp.local.json`.

## Verification

Run local tests:

```powershell
cd MCP-Servers/bridges/otter
npm test
npm audit --omit=dev --audit-level=moderate
```

Validate credentials through the installer:

```powershell
node Installers/MCP-Suite/Scripts/install.mjs --workspace=D:/tmp/otter-live-smoke --bridges=otter --non-interactive --field=OTTER_API_KEY=$env:OTTER_API_KEY
```

## References

- Otter.ai Public API: https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API
- Otter hosted MCP setup: https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server
