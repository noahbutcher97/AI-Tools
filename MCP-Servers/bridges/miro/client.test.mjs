import assert from "node:assert/strict";
import { test } from "node:test";

import { MiroClient } from "./client.mjs";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

// The bridge models seventeen specific operations and offers no escape hatch, so
// an item type it does not model is simply unreadable. Three types on real
// boards - table, table_text and widgets_stack - serialize with null content
// because the API itself marks them unsupported, and the items endpoint rejects
// them as a type filter, so they cannot even be enumerated selectively.
//
// A generic passthrough is what makes those reachable, and makes the next
// unmodelled type reachable without another bridge change.
// See docs/superpowers/plans/2026-08-17-mcp-bridge-audit-remediation.md.

test("rawRequest reaches an arbitrary API path", async () => {
  const seen = [];
  const c = new MiroClient("tok", {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, { ok: true });
    },
  });

  await c.rawRequest("/v2/boards/abc/items");
  assert.equal(seen[0], "https://api.miro.com/v2/boards/abc/items");
});

test("rawRequest reaches a path outside the version the client defaults to", async () => {
  // The client's base URL already ends in /v2, so a naive join would mangle an
  // experimental or v1 path - which is exactly what a passthrough exists for.
  const seen = [];
  const c = new MiroClient("tok", {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, {});
    },
  });

  await c.rawRequest("/v2-experimental/boards/abc/tables");
  assert.equal(seen[0], "https://api.miro.com/v2-experimental/boards/abc/tables");
});

test("rawRequest coerces numeric query values instead of rejecting them", async () => {
  const seen = [];
  const c = new MiroClient("tok", {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, {});
    },
  });

  await c.rawRequest("/v2/boards/abc/items", { method: "GET", queryParams: { limit: 50 } });
  assert.ok(seen[0].includes("limit=50"), `numeric query params must work, got ${seen[0]}`);
});

test("rawRequest sends a JSON body on POST", async () => {
  const seen = [];
  const c = new MiroClient("tok", {
    fetchImpl: async (url, opts) => {
      seen.push(opts);
      return response(200, {});
    },
  });

  await c.rawRequest("/v2/boards/abc/items", { method: "POST", bodyJson: { type: "shape" } });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body, JSON.stringify({ type: "shape" }));
});

test("rawRequest omits a body on GET", async () => {
  const seen = [];
  const c = new MiroClient("tok", {
    fetchImpl: async (url, opts) => {
      seen.push(opts);
      return response(200, {});
    },
  });

  await c.rawRequest("/v2/boards/abc/items", { method: "GET", bodyJson: { nope: true } });
  assert.equal(seen[0].body, undefined);
});

test("rawRequest carries the auth header", async () => {
  const seen = [];
  const c = new MiroClient("tok", {
    fetchImpl: async (url, opts) => {
      seen.push(opts);
      return response(200, {});
    },
  });

  await c.rawRequest("/v2/boards");
  assert.equal(seen[0].headers.Authorization, "Bearer tok");
});

test("rawRequest attaches the HTTP status to thrown errors", async () => {
  const c = new MiroClient("tok", { fetchImpl: async () => response(404, "no such board") });

  await assert.rejects(
    () => c.rawRequest("/v2/boards/nope"),
    (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.body, "no such board");
      return true;
    },
  );
});
