# Discord and Otter MCP Bridges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two repo-owned, installer-supported MCP bridges: `discord` and `otter`.

**Architecture:** Both bridges should follow the existing co-located bridge shape under `MCP-Servers/bridges/<name>/`: bridge `manifest.json`, `package.json`, `package-lock.json`, `server.mjs`, focused test files, and shared config loading through `MCP-Servers/lib/bridge-base.mjs`. The root installer catalog in `MCP-Servers/manifest.json` advertises both bridges, while the installer continues writing public values to `.mcp.json` and secrets to `.mcp.local.json`.

**Tech Stack:** Node 18+ ESM, `@modelcontextprotocol/sdk`, `zod`, built-in `node:test`, Discord REST API v10, Otter.ai Public API v1.

---

## Research Summary

Discord should be implemented as a bot-token bridge, not as a user-token or self-bot bridge. Official Discord docs state that bot tokens authenticate as bot users, are used for Gateway and most REST calls, inherit server permissions granted through OAuth2 install, and must be treated like passwords. For this repo, use HTTP REST only for v1; no Gateway connection is needed for on-demand MCP tools.

Discord caveats that must shape the bridge:
- Discord's base REST API is `https://discord.com/api`, and current available API version is v10.
- Bot setup requires creating a Discord application, adding a bot user, and inviting it to a server with the `bot` scope and required permissions.
- Message content is restricted: if the app lacks the privileged `MESSAGE_CONTENT` intent, message fields such as `content`, `embeds`, and `attachments` can be empty in relevant contexts.
- Search guild messages requires `READ_MESSAGE_HISTORY` and is restricted by the message content privileged intent. Do not include search in v1 unless tested with an approved bot.
- Discord rate limits are dynamic. The client must inspect `Retry-After` / `retry_after` on 429 responses rather than hard-coding rate constants.

Otter should be implemented against Otter's Public API, not by scraping or by wrapping unofficial APIs. Official Otter docs say Public API access is available for Enterprise workspaces and exposes channels, conversations, transcripts, audio links, action items, insights, outlines, and workspace details. Otter's hosted MCP server exists at `https://mcp.otter.ai/mcp`, but it is OAuth-authenticated remote MCP and does not match this repo's local stdio, repo-owned bridge pattern.

Otter caveats that must shape the bridge:
- API keys are created from Otter's Integrations > Developer tab, are only visible once, and should be stored as secrets.
- Otter uses `Authorization: Bearer YOUR_API_KEY`.
- Enterprise plan users are currently limited to 10 requests per second.
- List endpoints use cursor pagination with `meta.has_more` and `meta.next_cursor`.
- `GET /conversations/{id}` requires an `include` parameter for relationships such as `action_items`, `insights`, `outline`, `transcript`, or `all`.

Repo constraints from the current worktree:
- Co-located bridges live under `MCP-Servers/bridges/<name>/`.
- Each existing repo-owned bridge has a bridge-local `manifest.json`, `server.mjs`, `package.json`, and lockfile.
- The root installer catalog is `MCP-Servers/manifest.json`.
- Bridge startup should call `loadBridgeConfigOrExit("<bridge>", manifest.fields)` from `MCP-Servers/lib/bridge-base.mjs`.
- Installer validation currently supports HTTP `basic` and `bearer` auth only. Discord bot tokens require `Authorization: Bot <token>`, so the installer validator needs a small new auth mode before Discord can be manifest-validated cleanly.
- Unscoped list tools should follow the current `scope` + `warning` convention when omission broadens reads across multiple servers, channels, workspaces, teams, or similar resource boundaries.

## External Sources

- Discord OAuth2 and Permissions: https://docs.discord.com/developers/platform/oauth2-and-permissions
- Discord Bots overview: https://docs.discord.com/developers/bots/overview
- Discord API reference: https://docs.discord.com/developers/reference
- Discord channel resource: https://docs.discord.com/developers/resources/channel
- Discord guild resource: https://docs.discord.com/developers/resources/guild
- Discord message resource: https://docs.discord.com/developers/resources/message
- Discord rate limits: https://docs.discord.com/developers/topics/rate-limits
- Otter Public API: https://help.otter.ai/hc/en-us/articles/36130822688279-Otter-ai-Public-API
- Otter MCP Server: https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server

## File Structure

Create:
- `MCP-Servers/bridges/discord/manifest.json`: installer metadata, fields, and validation for Discord.
- `MCP-Servers/bridges/discord/package.json`: bridge package metadata and test script.
- `MCP-Servers/bridges/discord/package-lock.json`: locked dependency graph.
- `MCP-Servers/bridges/discord/client.mjs`: Discord REST client, auth header construction, allowed-guild checks, and rate-limit retry.
- `MCP-Servers/bridges/discord/client.test.mjs`: unit tests for auth headers, URL construction, scope enforcement, message payload safety, and 429 retry.
- `MCP-Servers/bridges/discord/server.mjs`: MCP server registration and Discord tool schemas.
- `MCP-Servers/bridges/otter/manifest.json`: installer metadata, fields, and validation for Otter.
- `MCP-Servers/bridges/otter/package.json`: bridge package metadata and test script.
- `MCP-Servers/bridges/otter/package-lock.json`: locked dependency graph.
- `MCP-Servers/bridges/otter/client.mjs`: Otter REST client, cursor handling, include normalization, and rate-limit retry.
- `MCP-Servers/bridges/otter/client.test.mjs`: unit tests for auth headers, URL construction, cursor params, include validation, and 429 retry.
- `MCP-Servers/bridges/otter/server.mjs`: MCP server registration and Otter tool schemas.

Modify:
- `MCP-Servers/manifest.json`: add `discord` and `otter` entries under `bridges`.
- `Installers/MCP-Suite/Scripts/install.mjs`: extend `validateHttp` to support prefixed auth schemes such as `Bot`.
- `MCP-Servers/README.md`: add Discord and Otter to the available bridges table and update quick-start wording if needed.

## Bridge Tool Surfaces

Discord v1 tools:
- `connection_info`: validates the token-derived bot identity and configured allowed guilds.
- `discord_list_guilds`: list guilds the bot belongs to. If `DISCORD_ALLOWED_GUILD_IDS` is set, mark blocked guilds without exposing deeper tools for them.
- `discord_get_guild_channels`: list channels in one guild. Requires a guild ID and enforces `DISCORD_ALLOWED_GUILD_IDS`.
- `discord_get_channel`: get a channel by ID. If the channel has a `guild_id`, enforce `DISCORD_ALLOWED_GUILD_IDS`.
- `discord_get_channel_messages`: get recent channel messages with `limit`, `before`, `after`, or `around`. Fetch channel metadata first for guild scoping.
- `discord_send_message`: send a message to a channel. Default `allowed_mentions` must be `{ "parse": [] }`; require an explicit boolean such as `allowMentions: true` before allowing mention parsing.

Discord v1 deliberately excludes broad moderation/admin tools, guild member listing, generic REST requests, Gateway subscriptions, and message search. Those can come later after explicit scope review.

Otter v1 tools:
- `connection_info`: validates workspace identity through `GET /workspace`.
- `otter_get_workspace`: return authenticated workspace details.
- `otter_list_channels`: list channels for the authenticated user.
- `otter_get_channel_members`: list members for one channel.
- `otter_list_conversations`: list conversations with `includeShared`, `channelId`, `limit`, and `cursor`; when `channelId` is absent and shared conversations are included, wrap output with `scope` and `warning`.
- `otter_get_conversation`: get one conversation with `include` constrained to `action_items`, `insights`, `outline`, `transcript`, or `all`.
- `otter_get_conversation_audio`: return the MP3 download URL for one conversation.

Otter v1 deliberately excludes `POST /conversations` import and webhooks. Import is a write operation and webhook support requires an inbound HTTP receiver, which does not fit this repo's stdio bridge model without a separate service design.

## Task 1: Extend Installer HTTP Validation Auth

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`

- [ ] **Step 1: Write the failing validation unit test harness**

The installer currently has no dedicated test harness. Add a narrow exported helper only if needed, or keep this as a manual code-review step if adding tests would require a larger installer refactor. The behavior to prove is:

```js
const auth = { type: "header", header: "Authorization", value: "Bot {DISCORD_BOT_TOKEN}" };
const headers = buildValidationHeaders(auth, { DISCORD_BOT_TOKEN: "abc123" });
assert.equal(headers.Authorization, "Bot abc123");
```

- [ ] **Step 2: Implement a small header-auth branch**

Change `validateHttp` so manifests can define explicit auth headers:

```js
  if (v.auth?.type === "basic") {
    const user = interpolate(v.auth.user, allValues);
    const pass = interpolate(v.auth.pass, allValues);
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  } else if (v.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${interpolate(v.auth.token, allValues)}`;
  } else if (v.auth?.type === "header") {
    const headerName = interpolate(v.auth.header, allValues);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(headerName)) {
      return { ok: false, error: `Invalid auth header name: ${headerName}` };
    }
    headers[headerName] = interpolate(v.auth.value, allValues);
  }
```

- [ ] **Step 3: Syntax-check installer**

Run:

```powershell
node --check Installers/MCP-Suite/Scripts/install.mjs
```

Expected: exit code 0.

## Task 2: Add the Discord Bridge

**Files:**
- Create: `MCP-Servers/bridges/discord/manifest.json`
- Create: `MCP-Servers/bridges/discord/package.json`
- Create: `MCP-Servers/bridges/discord/package-lock.json`
- Create: `MCP-Servers/bridges/discord/client.mjs`
- Create: `MCP-Servers/bridges/discord/client.test.mjs`
- Create: `MCP-Servers/bridges/discord/server.mjs`

- [ ] **Step 1: Create the package metadata**

`MCP-Servers/bridges/discord/package.json`:

```json
{
  "name": "discord-bridge-mcp",
  "version": "1.0.0",
  "description": "Discord MCP bridge for bot-token server and channel operations",
  "type": "module",
  "main": "server.mjs",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "zod": "^3.23.8"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Create the bridge manifest**

`MCP-Servers/bridges/discord/manifest.json`:

```json
{
  "schemaVersion": "1.0",
  "name": "discord",
  "displayName": "Discord",
  "description": "Discord bot-token bridge for guild, channel, and message operations.",
  "version": "1.0.0",
  "main": "server.mjs",
  "package": "package.json",
  "fields": [
    {
      "name": "DISCORD_BOT_TOKEN",
      "label": "Discord bot token",
      "type": "string",
      "secret": true,
      "required": true,
      "openUrl": "https://discord.com/developers/applications",
      "instructions": [
        "Create or open a Discord application, add a bot user, reset/copy the bot token, and invite the bot to the target server.",
        "Grant the bot only the permissions it needs: View Channels, Read Message History, Send Messages, and any thread permissions you choose to add later."
      ]
    },
    {
      "name": "DISCORD_ALLOWED_GUILD_IDS",
      "label": "Allowed Discord guild IDs (optional comma-separated allowlist)",
      "type": "string",
      "secret": false,
      "required": false,
      "instructions": [
        "Optional safety allowlist. When set, tools refuse guild-scoped operations outside these guild IDs."
      ],
      "examplePlaceholder": "123456789012345678,234567890123456789"
    }
  ],
  "validate": {
    "type": "http",
    "url": "https://discord.com/api/v10/users/@me",
    "method": "GET",
    "auth": { "type": "header", "header": "Authorization", "value": "Bot {DISCORD_BOT_TOKEN}" },
    "expectStatus": 200,
    "successMessage": "Authenticated Discord bot as {response.username} ({response.id}).",
    "errorHints": {
      "401": "Token rejected. Make sure this is a Bot token, not an OAuth user token or client secret.",
      "403": "Token authenticated but cannot access this endpoint. Check bot configuration.",
      "429": "Discord rate-limited validation. Wait for Retry-After and try again."
    }
  }
}
```

- [ ] **Step 3: Implement and test `DiscordClient`**

`client.mjs` must export:

```js
export class DiscordClient {
  constructor({ token, allowedGuildIds = "", fetchImpl = fetch }) {
    this.baseUrl = "https://discord.com/api/v10";
    this.token = token;
    this.fetch = fetchImpl;
    this.allowedGuildIds = parseAllowedGuildIds(allowedGuildIds);
  }
}

export function parseAllowedGuildIds(value) {
  return new Set(String(value || "").split(",").map((s) => s.trim()).filter(Boolean));
}
```

Client methods to implement:
- `request(path, params, method, body)`
- `getCurrentUser()`
- `listGuilds(limit)`
- `getGuildChannels(guildId)`
- `getChannel(channelId)`
- `getChannelMessages(channelId, opts)`
- `sendMessage(channelId, content, opts)`
- `assertGuildAllowed(guildId)`
- `assertChannelAllowed(channelId)`

Request behavior:
- Always send `Authorization: Bot <token>`.
- Use JSON bodies for writes.
- On HTTP 429, read `retry_after` from JSON or `Retry-After` from headers, sleep once, and retry once.
- On non-OK responses, throw an error containing status and response text.
- Before channel message reads/writes, fetch channel metadata and enforce `DISCORD_ALLOWED_GUILD_IDS` when `guild_id` exists.
- For `sendMessage`, default `allowed_mentions` to `{ parse: [] }`; only pass caller-specified mention parsing when `allowMentions === true`.

Tests:

```powershell
cd MCP-Servers/bridges/discord
npm test
```

Expected: tests pass.

- [ ] **Step 4: Register Discord MCP tools**

`server.mjs` must:
- Load `manifest.json`.
- Call `loadBridgeConfigOrExit("discord", manifest.fields)`.
- Resolve `DISCORD_BOT_TOKEN` and `DISCORD_ALLOWED_GUILD_IDS`.
- Create `McpServer({ name: "discord-bridge", version: "1.0.0" })`.
- Register the six v1 tools listed in "Bridge Tool Surfaces".
- Return all data through `toolJsonResult` and errors through `toolErrorResult`.

- [ ] **Step 5: Install lockfile**

Run:

```powershell
cd MCP-Servers/bridges/discord
npm install --package-lock-only
npm ci --dry-run
```

Expected: both commands exit 0.

## Task 3: Add the Otter Bridge

**Files:**
- Create: `MCP-Servers/bridges/otter/manifest.json`
- Create: `MCP-Servers/bridges/otter/package.json`
- Create: `MCP-Servers/bridges/otter/package-lock.json`
- Create: `MCP-Servers/bridges/otter/client.mjs`
- Create: `MCP-Servers/bridges/otter/client.test.mjs`
- Create: `MCP-Servers/bridges/otter/server.mjs`

- [ ] **Step 1: Create the package metadata**

`MCP-Servers/bridges/otter/package.json`:

```json
{
  "name": "otter-bridge-mcp",
  "version": "1.0.0",
  "description": "Otter.ai MCP bridge for Enterprise Public API meeting data",
  "type": "module",
  "main": "server.mjs",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "zod": "^3.23.8"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Create the bridge manifest**

`MCP-Servers/bridges/otter/manifest.json`:

```json
{
  "schemaVersion": "1.0",
  "name": "otter",
  "displayName": "Otter.ai",
  "description": "Otter.ai Enterprise Public API bridge for workspace, channel, conversation, transcript, and audio-link retrieval.",
  "version": "1.0.0",
  "main": "server.mjs",
  "package": "package.json",
  "fields": [
    {
      "name": "OTTER_API_KEY",
      "label": "Otter.ai API key",
      "type": "string",
      "secret": true,
      "required": true,
      "openUrl": "https://otter.ai/settings/integrations/developer",
      "instructions": [
        "Otter Public API is available for Enterprise workspaces.",
        "Open Otter, go to Integrations, then Developer, create an API key, copy it once, and paste it here."
      ]
    }
  ],
  "validate": {
    "type": "http",
    "url": "https://api.otter.ai/v1/workspace",
    "method": "GET",
    "auth": { "type": "bearer", "token": "{OTTER_API_KEY}" },
    "expectStatus": 200,
    "successMessage": "Authenticated Otter workspace: {response.data.name}.",
    "errorHints": {
      "401": "API key rejected. Create a fresh Otter Developer API key and paste it again.",
      "403": "API key authenticated but the workspace may not have Enterprise/Public API access.",
      "404": "Authenticated user is not in an Otter workspace, or the Public API endpoint is unavailable for this account.",
      "429": "Otter rate limit hit. Enterprise API is currently limited to 10 requests per second."
    }
  }
}
```

- [ ] **Step 3: Implement and test `OtterClient`**

`client.mjs` must export:

```js
export const OTTER_INCLUDE_VALUES = new Set(["action_items", "insights", "outline", "transcript", "all"]);

export class OtterClient {
  constructor({ apiKey, fetchImpl = fetch }) {
    this.baseUrl = "https://api.otter.ai/v1";
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }
}
```

Client methods to implement:
- `request(path, params, method, body)`
- `getWorkspace()`
- `listChannels()`
- `getChannelMembers(channelId)`
- `listConversations({ includeShared, channelId, limit, cursor })`
- `getConversation(conversationId, include)`
- `getConversationAudio(conversationId)`
- `normalizeInclude(include)`

Request behavior:
- Always send `Authorization: Bearer <apiKey>`.
- Use cursor params exactly as Otter documents them.
- Clamp list limits to 1-100.
- On HTTP 429, read `retry_after` from JSON or `Retry-After` from headers, sleep once, and retry once.
- `normalizeInclude` must reject unknown include values and default to `transcript,action_items,insights,outline` rather than `all`.

Tests:

```powershell
cd MCP-Servers/bridges/otter
npm test
```

Expected: tests pass.

- [ ] **Step 4: Register Otter MCP tools**

`server.mjs` must:
- Load `manifest.json`.
- Call `loadBridgeConfigOrExit("otter", manifest.fields)`.
- Resolve `OTTER_API_KEY`.
- Create `McpServer({ name: "otter-bridge", version: "1.0.0" })`.
- Register the seven v1 tools listed in "Bridge Tool Surfaces".
- Return all data through `toolJsonResult` and errors through `toolErrorResult`.
- For `otter_list_conversations`, include a `scope` field and warning if caller requests shared conversations without `channelId`.

- [ ] **Step 5: Install lockfile**

Run:

```powershell
cd MCP-Servers/bridges/otter
npm install --package-lock-only
npm ci --dry-run
```

Expected: both commands exit 0.

## Task 4: Register Bridges in the Root Catalog and Docs

**Files:**
- Modify: `MCP-Servers/manifest.json`
- Modify: `MCP-Servers/README.md`

- [ ] **Step 1: Add root manifest entries**

Add under `bridges`:

```json
    "discord": {
      "displayName": "Discord",
      "summary": "Discord guild, channel, and message operations as MCP tools.",
      "source": { "type": "co-located", "path": "bridges/discord" }
    },
    "otter": {
      "displayName": "Otter.ai",
      "summary": "Otter.ai workspace, channel, conversation, transcript, and audio-link operations as MCP tools.",
      "source": { "type": "co-located", "path": "bridges/otter" }
    }
```

- [ ] **Step 2: Update README bridge table**

Add rows:

```markdown
| `discord` | Discord guild, channel, and message operations through a bot token |
| `otter` | Otter.ai Enterprise Public API meeting data, transcripts, action items, insights, and audio links |
```

- [ ] **Step 3: Keep docs honest about Otter availability**

Mention that Otter Public API requires Enterprise workspace access. Users who only want Otter's hosted OAuth MCP can configure `https://mcp.otter.ai/mcp` directly in clients that support remote MCP, but that is separate from this repo-owned local bridge.

## Task 5: Installer and Bridge Verification

**Files:**
- All changed files.

- [ ] **Step 1: Syntax-check tracked bridge JavaScript**

Run:

```powershell
git ls-files "MCP-Servers/**/*.mjs" "Installers/MCP-Suite/Scripts/**/*.mjs" | % { node --check $_ }
```

Expected: exit code 0 for every tracked `.mjs` file.

- [ ] **Step 2: Run bridge unit tests**

Run:

```powershell
cd MCP-Servers/bridges/discord; npm test
cd ..\otter; npm test
cd ..\perforce; npm test
```

Expected: all tests pass.

- [ ] **Step 3: Verify lockfile consistency**

Run:

```powershell
cd MCP-Servers/bridges/discord; npm ci --dry-run
cd ..\otter; npm ci --dry-run
```

Expected: both commands exit 0.

- [ ] **Step 4: Run installer doctor**

Run:

```powershell
node Installers/MCP-Suite/Scripts/install.mjs --doctor --workspace=D:/DevTools/AI-Tools
```

Expected: doctor lists `discord` and `otter` as available root-manifest bridges. Status may be `absent` unless configured in this workspace.

- [ ] **Step 5: Run non-interactive config smoke with dummy invalid credentials**

Use a temporary workspace under `D:\tmp` so real workspace config is not mutated:

```powershell
$tmp = "D:\tmp\ai-tools-mcp-bridge-smoke"
New-Item -ItemType Directory -Force $tmp | Out-Null
node Installers/MCP-Suite/Scripts/install.mjs --workspace=$tmp --bridges=discord,otter --non-interactive --field=DISCORD_BOT_TOKEN=invalid --field=OTTER_API_KEY=invalid
```

Expected: installer attempts validation and skips saving each bridge with clear 401-oriented hints. This proves manifest discovery and promptless credential resolution without needing real secrets.

## Task 6: Optional Live Credential Validation

**Files:**
- No code changes expected.

- [ ] **Step 1: Validate Discord with a real bot token if provided**

Run:

```powershell
node Installers/MCP-Suite/Scripts/install.mjs --workspace=D:/tmp/discord-live-smoke --bridges=discord --non-interactive --field=DISCORD_BOT_TOKEN=<real-token>
```

Expected: validation reports the authenticated Discord bot identity and writes `.mcp.json` plus `.mcp.local.json` in the temp workspace.

- [ ] **Step 2: Validate Otter with a real Enterprise API key if provided**

Run:

```powershell
node Installers/MCP-Suite/Scripts/install.mjs --workspace=D:/tmp/otter-live-smoke --bridges=otter --non-interactive --field=OTTER_API_KEY=<real-key>
```

Expected: validation reports the authenticated Otter workspace and writes `.mcp.json` plus `.mcp.local.json` in the temp workspace.

## Self-Review

Spec coverage:
- Two MCP servers are scoped: `discord` and `otter`.
- Both are repo-owned, co-located bridges and are installer-supported through the root manifest.
- Both follow existing bridge parity: manifest, server, package, lockfile, shared config loader, installer validation, unit tests, and doctor/install verification.
- Discord's installer validation gap is explicitly included as Task 1.
- Otter's Enterprise-only API constraint and hosted remote MCP alternative are explicitly documented.

Red-flag scan:
- No implementation task depends on vague future-fill language or unspecified paths.
- The only optional lane is live credential validation because real Discord and Otter credentials may not be available in this workspace.

Risk notes:
- Discord message content can be empty without privileged intent. The bridge should surface this as a `warning` in message-read outputs when content is absent.
- Discord writes must suppress mentions by default.
- Otter `include=all` can return large transcripts and relationship payloads. The tool should default to targeted includes.
- Do not add a generic Discord REST tool in v1; it would expose too much mutation authority behind a single bot token.
