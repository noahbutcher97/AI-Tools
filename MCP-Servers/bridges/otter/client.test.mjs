import assert from "node:assert/strict";
import { test } from "node:test";

import { OtterClient } from "./client.mjs";

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

test("request sends Otter bearer auth", async () => {
  const calls = [];
  const client = new OtterClient({
    apiKey: "otter-key",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, { data: { id: 42, name: "Workspace" } });
    },
  });

  const result = await client.getWorkspace();

  assert.equal(result.data.name, "Workspace");
  assert.equal(calls[0].url, "https://api.otter.ai/v1/workspace");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer otter-key");
});

test("listConversations uses cursor pagination and channel scoping", async () => {
  const calls = [];
  const client = new OtterClient({
    apiKey: "key",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, { meta: { has_more: false }, data: [] });
    },
  });

  await client.listConversations({
    includeShared: false,
    channelId: "channel-1",
    limit: 500,
    cursor: "cursor-1",
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/conversations");
  assert.equal(url.searchParams.get("channel_id"), "channel-1");
  assert.equal(url.searchParams.get("include_shared"), "true");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("cursor"), "cursor-1");
});

test("normalizeInclude defaults to targeted relationship fields", () => {
  const client = new OtterClient({ apiKey: "key" });

  assert.equal(client.normalizeInclude(), "transcript,action_items,insights,outline");
});

test("normalizeInclude rejects unsupported include values", () => {
  const client = new OtterClient({ apiKey: "key" });

  assert.throws(() => client.normalizeInclude("transcript,unknown"), /Unsupported Otter include value/);
});

test("getConversation includes normalized relationship fields", async () => {
  const calls = [];
  const client = new OtterClient({
    apiKey: "key",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, { data: { id: "conversation-1" } });
    },
  });

  await client.getConversation("conversation-1", ["transcript", "action_items"]);

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/conversations/conversation-1");
  assert.equal(url.searchParams.get("include"), "transcript,action_items");
});

test("resource IDs cannot escape their REST path segment", async () => {
  const calls = [];
  const client = new OtterClient({
    apiKey: "key",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, { data: {} });
    },
  });

  await assert.rejects(() => client.getChannelMembers("../workspace"), /Invalid Otter channel ID/);
  await assert.rejects(() => client.getConversation("../workspace"), /Invalid Otter conversation ID/);
  await assert.rejects(() => client.getConversationAudio("../workspace"), /Invalid Otter conversation ID/);
  assert.equal(calls.length, 0);
});

test("request retries one Otter 429 using retry_after", async () => {
  const calls = [];
  const sleeps = [];
  const client = new OtterClient({
    apiKey: "key",
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (calls.length === 1) {
        return jsonResponse(429, { retry_after: 0.5 }, { "retry-after": "2" });
      }
      return jsonResponse(200, { data: [] });
    },
  });

  const result = await client.listChannels();

  assert.deepEqual(result, { data: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [500]);
});
