export function parseAllowedGuildIds(value) {
  return new Set(String(value || "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function parseAllowedMentionsInput(allowMentions, value) {
  if (allowMentions !== true || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`allowedMentionsJson must be valid JSON: ${e.message}`);
  }
}

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJsonSafe(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

async function readTextSafe(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function clampLimit(value, min, max, fallback) {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}

function encodeResourceId(value, label) {
  const id = String(value ?? "").trim();
  if (!id || /[\\/?#\u0000-\u001F\u007F]/.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid Discord ${label} ID: ${id || "(empty)"}`);
  }
  return encodeURIComponent(id);
}

function assertExclusiveMessageCursor({ before, after, around } = {}) {
  const provided = [before, after, around].filter((value) => value !== undefined && value !== null && value !== "");
  if (provided.length > 1) {
    throw new Error("Only one of before, after, or around may be supplied.");
  }
}

export class DiscordClient {
  constructor({ token, allowedGuildIds = "", fetchImpl = fetch, sleepImpl = DEFAULT_SLEEP }) {
    this.baseUrl = "https://discord.com/api/v10";
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.allowedGuildIds = parseAllowedGuildIds(allowedGuildIds);
  }

  async request(path, params = {}, method = "GET", body = null, retry = true) {
    const url = new URL(String(path).replace(/^\/+/, ""), `${this.baseUrl}/`);
    if (method === "GET") {
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const opts = {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        Accept: "application/json",
      },
    };

    if (body !== null && body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const resp = await this.fetch(url.toString(), opts);
    if (resp.status === 429 && retry) {
      const json = await readJsonSafe(resp);
      const retryAfter = Number(json?.retry_after ?? resp.headers?.get?.("Retry-After") ?? 1);
      await this.sleep(Math.max(0, retryAfter) * 1000);
      return this.request(path, params, method, body, false);
    }

    if (!resp.ok) {
      const text = await readTextSafe(resp);
      throw new Error(`Discord API ${resp.status}: ${text}`);
    }

    if (resp.status === 204) return null;
    return await readJsonSafe(resp);
  }

  async getCurrentUser() {
    return await this.request("/users/@me");
  }

  async listGuilds(limit = 100) {
    return await this.request("/users/@me/guilds", { limit: clampLimit(limit, 1, 200, 100) });
  }

  async getGuildChannels(guildId) {
    this.assertGuildAllowed(guildId);
    return await this.request(`/guilds/${encodeResourceId(guildId, "guild")}/channels`);
  }

  async getChannel(channelId) {
    const channel = await this.request(`/channels/${encodeResourceId(channelId, "channel")}`);
    if (channel?.guild_id) this.assertGuildAllowed(channel.guild_id);
    return channel;
  }

  async assertChannelAllowed(channelId) {
    const channel = await this.request(`/channels/${encodeResourceId(channelId, "channel")}`);
    if (channel?.guild_id) this.assertGuildAllowed(channel.guild_id);
    return channel;
  }

  async getChannelMessages(channelId, opts = {}) {
    assertExclusiveMessageCursor(opts);
    await this.assertChannelAllowed(channelId);
    return await this.request(`/channels/${encodeResourceId(channelId, "channel")}/messages`, {
      limit: clampLimit(opts.limit, 1, 100, 50),
      before: opts.before,
      after: opts.after,
      around: opts.around,
    });
  }

  async sendMessage(channelId, content, opts = {}) {
    const replyToMessageId = opts.replyToMessageId
      ? encodeResourceId(opts.replyToMessageId, "message")
      : null;
    await this.assertChannelAllowed(channelId);
    const body = {
      content,
      allowed_mentions: opts.allowMentions === true && opts.allowedMentions
        ? opts.allowedMentions
        : { parse: [] },
    };
    if (replyToMessageId) {
      body.message_reference = { message_id: replyToMessageId };
    }
    return await this.request(`/channels/${encodeResourceId(channelId, "channel")}/messages`, {}, "POST", body);
  }

  assertGuildAllowed(guildId) {
    if (this.allowedGuildIds.size === 0) return;
    if (!this.allowedGuildIds.has(String(guildId))) {
      throw new Error(`Discord guild '${guildId}' is not in DISCORD_ALLOWED_GUILD_IDS`);
    }
  }
}
