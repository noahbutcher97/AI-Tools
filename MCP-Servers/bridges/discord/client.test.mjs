import assert from "node:assert/strict";
import { test } from "node:test";

import { DiscordClient, parseAllowedGuildIds, parseAllowedMentionsInput } from "./client.mjs";

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? headers[name] ?? null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("parseAllowedGuildIds trims comma-separated IDs", () => {
  assert.deepEqual(
    [...parseAllowedGuildIds(" 111,222 ,, 333 ")],
    ["111", "222", "333"],
  );
});

test("request sends Discord Bot auth and query parameters", async () => {
  const calls = [];
  const client = new DiscordClient({
    token: "token-123",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, [{ id: "guild-1" }]);
    },
  });

  const result = await client.listGuilds(5);

  assert.deepEqual(result, [{ id: "guild-1" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/v10/users/@me/guilds?limit=5");
  assert.equal(calls[0].opts.headers.Authorization, "Bot token-123");
});

test("assertGuildAllowed rejects guilds outside the allowlist", () => {
  const client = new DiscordClient({ token: "token", allowedGuildIds: "111,222" });

  assert.doesNotThrow(() => client.assertGuildAllowed("111"));
  assert.throws(() => client.assertGuildAllowed("333"), /not in DISCORD_ALLOWED_GUILD_IDS/);
});

test("getChannelMessages fetches channel metadata before enforcing guild scope", async () => {
  const calls = [];
  const client = new DiscordClient({
    token: "token",
    allowedGuildIds: "guild-1",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith("/channels/channel-1")) {
        return jsonResponse(200, { id: "channel-1", guild_id: "guild-2" });
      }
      return jsonResponse(200, []);
    },
  });

  await assert.rejects(
    () => client.getChannelMessages("channel-1", { limit: 10 }),
    /guild 'guild-2' is not in DISCORD_ALLOWED_GUILD_IDS/,
  );

  assert.equal(calls.length, 1);
});

test("channel and guild IDs cannot escape their REST path segment", async () => {
  const calls = [];
  const client = new DiscordClient({
    token: "token",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, { id: "bot-1" });
    },
  });

  await assert.rejects(() => client.getChannel("../users/@me"), /Invalid Discord channel ID/);
  await assert.rejects(() => client.getGuildChannels("../users/@me"), /Invalid Discord guild ID/);
  await assert.rejects(() => client.sendMessage("channel-1", "hello", { replyToMessageId: "../messages/1" }), /Invalid Discord message ID/);
  assert.equal(calls.length, 0);
});

test("getChannelMessages accepts only one cursor parameter", async () => {
  const calls = [];
  const client = new DiscordClient({
    token: "token",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, { id: "channel-1", guild_id: "guild-1" });
    },
  });

  await assert.rejects(
    () => client.getChannelMessages("channel-1", { before: "100", after: "200" }),
    /Only one of before, after, or around may be supplied/,
  );
  assert.equal(calls.length, 0);
});

test("sendMessage suppresses mentions by default", async () => {
  const calls = [];
  const client = new DiscordClient({
    token: "token",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith("/channels/channel-1")) {
        return jsonResponse(200, { id: "channel-1", guild_id: "guild-1" });
      }
      return jsonResponse(200, { id: "message-1" });
    },
  });

  await client.sendMessage("channel-1", "hello @everyone");

  const body = JSON.parse(calls[1].opts.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("sendMessage only allows mention parsing when explicitly requested", async () => {
  const calls = [];
  const client = new DiscordClient({
    token: "token",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith("/channels/channel-1")) {
        return jsonResponse(200, { id: "channel-1", guild_id: "guild-1" });
      }
      return jsonResponse(200, { id: "message-1" });
    },
  });

  await client.sendMessage("channel-1", "hello <@123>", {
    allowMentions: true,
    allowedMentions: { parse: ["users"] },
  });

  const body = JSON.parse(calls[1].opts.body);
  assert.deepEqual(body.allowed_mentions, { parse: ["users"] });
});

test("parseAllowedMentionsInput ignores unused JSON when mentions are disabled", () => {
  assert.equal(parseAllowedMentionsInput(false, "{not json"), undefined);
});

test("parseAllowedMentionsInput parses JSON only when mentions are enabled", () => {
  assert.deepEqual(
    parseAllowedMentionsInput(true, '{"parse":["users"]}'),
    { parse: ["users"] },
  );
  assert.throws(
    () => parseAllowedMentionsInput(true, "{not json"),
    /allowedMentionsJson must be valid JSON/,
  );
});

test("request retries one Discord 429 using retry_after", async () => {
  const calls = [];
  const sleeps = [];
  const client = new DiscordClient({
    token: "token",
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (calls.length === 1) {
        return jsonResponse(429, { retry_after: 0.25 }, { "retry-after": "1" });
      }
      return jsonResponse(200, { id: "bot-1" });
    },
  });

  const result = await client.getCurrentUser();

  assert.deepEqual(result, { id: "bot-1" });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [250]);
});
