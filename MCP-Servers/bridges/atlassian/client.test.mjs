import assert from "node:assert/strict";
import { test } from "node:test";

import { AtlassianClient } from "./client.mjs";

const CREDS = { siteName: "example", userEmail: "a@b.c", apiToken: "tok" };

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

// A bulk key lookup silently omits keys it cannot resolve, so a caller cannot
// tell a deleted issue from one it lacks permission to read. Telling those
// apart needs the HTTP status as a value; today it is formatted into the error
// message and lost. See docs/superpowers/plans/2026-08-17-mcp-bridge-audit-remediation.md.

test("request attaches the HTTP status to the thrown error", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(404, { errorMessages: ["Issue does not exist"] }),
  });

  await assert.rejects(
    () => client.request("/rest/api/3/issue/OA-761"),
    (err) => {
      assert.equal(err.status, 404, "err.status must carry the HTTP status");
      return true;
    },
  );
});

test("request distinguishes forbidden from not found by status", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(403, { errorMessages: ["Forbidden"] }),
  });

  await assert.rejects(
    () => client.request("/rest/api/3/issue/OA-1"),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    },
  );
});

test("request keeps the existing error message text intact", async () => {
  // Regression guard: consumers may match on the message string, so attaching
  // a status must not reword it.
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(500, "boom"),
  });

  await assert.rejects(
    () => client.request("/rest/api/3/issue/OA-1"),
    /^Error: Atlassian API 500: /,
  );
});

test("request exposes the response body for diagnostics", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(400, "bad jql"),
  });

  await assert.rejects(
    () => client.request("/rest/api/3/search/jql"),
    (err) => {
      assert.equal(err.body, "bad jql");
      return true;
    },
  );
});

test("request still returns parsed JSON on success", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(200, { key: "OA-829" }),
  });

  assert.deepEqual(await client.request("/rest/api/3/issue/OA-829"), { key: "OA-829" });
});

// ── validateKeys (audit item 1) ──
//
// A bulk `key in (...)` query returns only the keys it resolves, with no error
// and no list of what it dropped, so a caller reads omission as deletion. That
// inference is wrong in at least two ways: a key may be unreadable rather than
// absent, and a live issue can be missing from the search index entirely while
// remaining reachable by direct fetch.
//
// Searchability is checked with ONE bulk query over the keys that fetched OK,
// not a second fetch per key, so the whole check costs N+1 calls.

function keyResponses(map) {
  // map: { "OA-1": 200, "OA-2": 404, ... } -> a fetchImpl honoring it
  return async (url) => {
    const m = String(url).match(/\/issue\/([A-Z]+-\d+)/);
    if (m) {
      const status = map[m[1]] ?? 404;
      if (status === 200) return response(200, { key: m[1] });
      return response(status, { errorMessages: ["nope"] });
    }
    return response(200, { issues: [] });
  };
}

test("validateKeys returns one verdict per key and never drops one", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: keyResponses({ "OA-1": 200, "OA-2": 404, "OA-3": 403 }),
  });

  const r = await client.validateKeys(["OA-1", "OA-2", "OA-3"], { checkSearchable: false });

  assert.equal(r.results.length, 3);
  assert.deepEqual(r.results.map((x) => x.key), ["OA-1", "OA-2", "OA-3"]);
  assert.equal(r.total, 3);
});

test("validateKeys reports 404 as not_found_or_no_permission, never bare not_found", async () => {
  // The API returns the same 404 for a missing issue and one the caller may not
  // read, so a not_found verdict would be a fabrication.
  const client = new AtlassianClient(CREDS, { fetchImpl: keyResponses({ "OA-2": 404 }) });
  const r = await client.validateKeys(["OA-2"], { checkSearchable: false });
  assert.equal(r.results[0].verdict, "not_found_or_no_permission");
});

test("validateKeys reports an explicit 403 as no_permission", async () => {
  const client = new AtlassianClient(CREDS, { fetchImpl: keyResponses({ "OA-3": 403 }) });
  const r = await client.validateKeys(["OA-3"], { checkSearchable: false });
  assert.equal(r.results[0].verdict, "no_permission");
});

test("validateKeys flags a live issue that is absent from the search index", async () => {
  // The OA-829 case: fetches fine, invisible to every JQL query.
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async (url, opts) => {
      const m = String(url).match(/\/issue\/([A-Z]+-\d+)/);
      if (m) return response(200, { key: m[1] });
      // Bulk search resolves OA-1 but not OA-829.
      return response(200, { issues: [{ key: "OA-1" }], isLast: true });
    },
  });

  const r = await client.validateKeys(["OA-1", "OA-829"], { checkSearchable: true });
  const byKey = Object.fromEntries(r.results.map((x) => [x.key, x.verdict]));
  assert.equal(byKey["OA-1"], "exists");
  assert.equal(byKey["OA-829"], "exists_not_searchable");
});

test("validateKeys keeps a server error distinct from an absent issue", async () => {
  const client = new AtlassianClient(CREDS, { fetchImpl: keyResponses({ "OA-9": 500 }) });
  const r = await client.validateKeys(["OA-9"], { checkSearchable: false });
  assert.equal(r.results[0].verdict, "error");
  assert.equal(r.results[0].status, 500);
});

test("validateKeys does not abort the batch when one key fails", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: keyResponses({ "OA-1": 200, "OA-2": 500, "OA-3": 200 }),
  });
  const r = await client.validateKeys(["OA-1", "OA-2", "OA-3"], { checkSearchable: false });
  assert.equal(r.results.filter((x) => x.verdict === "exists").length, 2);
  assert.equal(r.summary.error, 1);
});

test("validateKeys reports rate limiting as its own verdict, not as absent", async () => {
  // A rate-limited key has an UNKNOWN status. Folding it into a missing-style
  // verdict would recreate the bug this tool exists to remove.
  let calls = 0;
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => {
      calls += 1;
      return response(429, "slow down");
    },
  });

  const r = await client.validateKeys(["OA-5"], { checkSearchable: false, maxRetries: 2, retryDelayMs: 0 });
  assert.equal(r.results[0].verdict, "rate_limited");
  assert.equal(r.unresolved, 1);
  assert.ok(calls > 1, "should have retried before giving up");
});

test("validateKeys counts a moved key by its resolved key", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async (url) => {
      if (/\/issue\//.test(String(url))) return response(200, { key: "NEW-7" });
      return response(200, { issues: [], isLast: true });
    },
  });
  const r = await client.validateKeys(["OLD-7"], { checkSearchable: false });
  assert.equal(r.results[0].verdict, "moved");
  assert.equal(r.results[0].resolvedKey, "NEW-7");
});

test("validateKeys summary totals reconcile with the result list", async () => {
  const client = new AtlassianClient(CREDS, {
    fetchImpl: keyResponses({ "OA-1": 200, "OA-2": 404, "OA-3": 404 }),
  });
  const r = await client.validateKeys(["OA-1", "OA-2", "OA-3"], { checkSearchable: false });
  const summed = Object.values(r.summary).reduce((a, b) => a + b, 0);
  assert.equal(summed, r.results.length, "every result must be counted exactly once");
});

test("validateKeys handles an empty key list without calling out", async () => {
  let calls = 0;
  const client = new AtlassianClient(CREDS, {
    fetchImpl: async () => { calls += 1; return response(200, {}); },
  });
  const r = await client.validateKeys([], { checkSearchable: true });
  assert.deepEqual(r.results, []);
  assert.equal(calls, 0);
});
