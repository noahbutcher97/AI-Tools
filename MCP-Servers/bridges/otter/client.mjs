export const OTTER_INCLUDE_VALUES = new Set(["action_items", "insights", "outline", "transcript", "all"]);

const DEFAULT_INCLUDE = "transcript,action_items,insights,outline";
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
    throw new Error(`Invalid Otter ${label} ID: ${id || "(empty)"}`);
  }
  return encodeURIComponent(id);
}

export class OtterClient {
  constructor({ apiKey, fetchImpl = fetch, sleepImpl = DEFAULT_SLEEP }) {
    this.baseUrl = "https://api.otter.ai/v1";
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
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
        Authorization: `Bearer ${this.apiKey}`,
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
      throw new Error(`Otter API ${resp.status}: ${text}`);
    }

    if (resp.status === 204) return null;
    return await readJsonSafe(resp);
  }

  async getWorkspace() {
    return await this.request("/workspace");
  }

  async listChannels() {
    return await this.request("/channels");
  }

  async getChannelMembers(channelId) {
    return await this.request(`/channels/${encodeResourceId(channelId, "channel")}/members`);
  }

  async listConversations({ includeShared = false, channelId = null, limit = 20, cursor = null } = {}) {
    const params = {
      include_shared: channelId ? true : Boolean(includeShared),
      channel_id: channelId,
      limit: clampLimit(limit, 1, 100, 20),
      cursor,
    };
    return await this.request("/conversations", params);
  }

  async getConversation(conversationId, include = undefined) {
    return await this.request(`/conversations/${encodeResourceId(conversationId, "conversation")}`, {
      include: this.normalizeInclude(include),
    });
  }

  async getConversationAudio(conversationId) {
    return await this.request(`/conversations/${encodeResourceId(conversationId, "conversation")}/audio`);
  }

  normalizeInclude(include = undefined) {
    if (include === undefined || include === null || include === "") return DEFAULT_INCLUDE;
    const values = Array.isArray(include)
      ? include
      : String(include).split(",");
    const normalized = values.map((v) => String(v).trim()).filter(Boolean);
    for (const value of normalized) {
      if (!OTTER_INCLUDE_VALUES.has(value)) {
        throw new Error(`Unsupported Otter include value '${value}'`);
      }
    }
    if (normalized.includes("all")) return "all";
    return normalized.join(",");
  }
}
