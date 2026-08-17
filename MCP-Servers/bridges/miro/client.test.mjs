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

// ── Connectors and full-board enumeration (audit items 8 and 9) ──
//
// Item 8: connectors are how the team encodes what blocks what, but the list
// returned endpoint IDs and nothing about what those items are, so reading the
// graph meant enumerating every card and joining by hand. Worse, some
// connectors came back with no endpoints at all, and there was no way to tell
// an unattached connector from a field the bridge had dropped — which is
// exactly the ambiguity that makes a finding unreportable.
//
// The answer, established against a live board: those connectors carry
// isSupported:false. The API declines to serialize them, the same marker it
// uses for table items. That reason has to reach the caller.

function connectorPage(connectors, total) {
  return { data: connectors, total: total ?? connectors.length, cursor: null };
}

test("getConnectors explains an absent endpoint instead of leaving it blank", async () => {
  const c = new MiroClient("tok", {
    fetchImpl: async () => response(200, connectorPage([
      { id: "c1", type: "connector", isSupported: false },
    ])),
  });

  const r = await c.getConnectors("b1");
  assert.equal(r.connectors[0].startItem, null);
  assert.match(
    r.connectors[0].endpointsUnavailable,
    /not supported|isSupported/i,
    "an absent endpoint must carry a reason, not just be missing",
  );
});

test("getConnectors leaves a fully attached connector unannotated", async () => {
  const c = new MiroClient("tok", {
    fetchImpl: async () => response(200, connectorPage([
      { id: "c2", type: "connector", startItem: { id: "i1" }, endItem: { id: "i2" } },
    ])),
  });

  const r = await c.getConnectors("b1");
  assert.equal(r.connectors[0].endpointsUnavailable, undefined);
  assert.equal(r.connectors[0].startItem.id, "i1");
});

test("getConnectors resolves endpoint ids to type and content when asked", async () => {
  // So the dependency graph is readable in one call rather than needing a
  // separate enumeration of every item to build an id-to-title map.
  const c = new MiroClient("tok", {
    fetchImpl: async (url) => {
      if (String(url).includes("/connectors")) {
        return response(200, connectorPage([
          { id: "c3", type: "connector", startItem: { id: "i1" }, endItem: { id: "i2" } },
        ]));
      }
      return response(200, {
        data: [
          { id: "i1", type: "card", data: { title: "Build pipeline" } },
          { id: "i2", type: "shape", data: { content: "<p>Ship it</p>" } },
        ],
        total: 2,
        cursor: null,
      });
    },
  });

  const r = await c.getConnectors("b1", { resolveEndpoints: true });
  assert.equal(r.connectors[0].startItem.type, "card");
  assert.equal(r.connectors[0].startItem.content, "Build pipeline");
  assert.equal(r.connectors[0].endItem.content, "Ship it");
});

test("getConnectors states completeness", async () => {
  const c = new MiroClient("tok", {
    fetchImpl: async () => response(200, { data: [{ id: "c1", type: "connector" }], total: 30, cursor: "next" }),
  });
  const r = await c.getConnectors("b1");
  assert.equal(r.total, 30);
  assert.equal(r.isLast, false);
});

test("getAllBoardItems pages through a board without the caller managing cursors", async () => {
  // A 320-item board at a 50-item cap is seven calls and a hand-held cursor.
  let call = 0;
  const c = new MiroClient("tok", {
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return response(200, { data: [{ id: "a", type: "shape" }], total: 2, cursor: "c1" });
      return response(200, { data: [{ id: "b", type: "shape" }], total: 2, cursor: null });
    },
  });

  const r = await c.getAllBoardItems("b1");
  assert.equal(r.items.length, 2);
  assert.equal(r.isLast, true);
  assert.equal(call, 2, "should have followed the cursor itself");
});

test("getAllBoardItems stops at a page budget and says it truncated", async () => {
  // No silent caps: a bounded sweep must not look like a complete one.
  const c = new MiroClient("tok", {
    fetchImpl: async () => response(200, { data: [{ id: "x", type: "shape" }], total: 999, cursor: "always-more" }),
  });

  const r = await c.getAllBoardItems("b1", { maxPages: 3 });
  assert.equal(r.isLast, false);
  assert.match(r.truncated, /maxPages|page/i);
});
