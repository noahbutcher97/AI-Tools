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

// ── ConfluenceClient: pagination and space listing (audit items 6 and 8) ──

import { ConfluenceClient } from "./client.mjs";

function v1Page(results, hasNext) {
  return {
    results,
    start: 0,
    limit: results.length,
    size: results.length,
    _links: hasNext ? { next: "/rest/api/content?next=true&start=100" } : {},
  };
}

test("confluence request attaches the HTTP status to thrown errors", async () => {
  const c = new ConfluenceClient(CREDS, { fetchImpl: async () => response(404, "gone") });
  await assert.rejects(
    () => c.request("/wiki/rest/api/space/NOPE"),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("getSpacePages forwards start so a space can be paged to completion", async () => {
  const seen = [];
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, v1Page([{ id: "1", title: "p" }], false));
    },
  });

  await c.getSpacePages("PO", 100, { start: 100 });
  assert.ok(seen[0].includes("start=100"), `start must reach the request, got ${seen[0]}`);
});

test("getSpacePages reports isLast false while a next link is present", async () => {
  // The audit's exact symptom: 100 rows returned, no way to tell there is more.
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, v1Page(new Array(100).fill({ id: "1", title: "p" }), true)),
  });

  const r = await c.getSpacePages("PO", 100);
  assert.equal(r.isLast, false, "a next link means this is not the last page");
  assert.equal(r.count, 100);
});

test("getSpacePages reports isLast true when a full page has no next link", async () => {
  // count === limit but complete. This is the case that is otherwise
  // indistinguishable from truncation.
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, v1Page(new Array(100).fill({ id: "1", title: "p" }), false)),
  });

  const r = await c.getSpacePages("PO", 100);
  assert.equal(r.isLast, true);
});

test("getSpacePages never fabricates a total the API did not supply", async () => {
  // The v1 endpoint returns a per-page size, not a collection total. Reporting
  // size as total would make every truncated page look complete.
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, v1Page([{ id: "1", title: "p" }], true)),
  });

  const r = await c.getSpacePages("PO", 100);
  assert.equal(r.total, null);
});

test("listSpaces returns spaces of a type the caller did not name", async () => {
  // The largest space on a real instance is type "collaboration", which the
  // documented global/personal filter excludes entirely.
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, v1Page([
      { key: "PO", name: "Project OnSight", type: "collaboration", status: "current" },
      { key: "MFS", name: "Other", type: "global", status: "current" },
    ], false)),
  });

  const r = await c.listSpaces({ limit: 100 });
  assert.deepEqual(r.spaces.map((s) => s.key).sort(), ["MFS", "PO"]);
});

test("listSpaces forwards a caller-supplied limit instead of discarding it", async () => {
  const seen = [];
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, v1Page([], false));
    },
  });

  await c.listSpaces({ limit: 100 });
  assert.ok(seen[0].includes("limit=100"), `limit must reach the request, got ${seen[0]}`);
});

test("listSpaces states completeness like every other list response", async () => {
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, v1Page([{ key: "PO", name: "x", type: "collaboration" }], true)),
  });

  const r = await c.listSpaces({ limit: 1 });
  assert.equal(r.isLast, false);
  assert.equal(r.count, 1);
  assert.equal(r.total, null);
});

// ── getPage: text output and historical versions (audit items 7 and 11) ──
//
// Item 7: two inventory pages returned 404,787 and 266,366 characters of HTML,
// exceeding the tool-result cap and forcing hand-written stripping on the
// caller's side. Item 11: version metadata was available but content was not,
// so "did this text exist at version N-1?" could not be answered.

function pageResponse(bodyHtml, versionNumber = 3) {
  return {
    id: "852005",
    title: "Magic Overview",
    status: "current",
    body: { storage: { value: bodyHtml } },
    version: { number: versionNumber, when: "2026-08-01T00:00:00Z", by: { displayName: "Someone" } },
    space: { key: "PO" },
    _links: {},
  };
}

test("getPage returns raw storage HTML by default", async () => {
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, pageResponse("<p>Magic</p>")),
  });
  const p = await c.getPage("852005");
  assert.equal(p.body, "<p>Magic</p>");
});

test("getPage returns readable text when asked, without client-side stripping", async () => {
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, pageResponse("<p>Magic</p><ac:image><ri:attachment ri:filename='x.png'/></ac:image><p>rides on top</p>")),
  });
  const p = await c.getPage("852005", "storage", { format: "text" });
  assert.equal(p.body, "Magic rides on top");
});

test("getPage reports both lengths so a caller can see what stripping saved", async () => {
  const html = "<p>abc</p><ac:structured-macro><ac:parameter>noise noise noise</ac:parameter></ac:structured-macro>";
  const c = new ConfluenceClient(CREDS, { fetchImpl: async () => response(200, pageResponse(html)) });
  const p = await c.getPage("852005", "storage", { format: "text" });
  assert.equal(p.bodyLength, 3, "text length");
  assert.equal(p.rawBodyLength, html.length, "original html length");
});

test("getPage requests a specific version when one is given", async () => {
  const seen = [];
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, pageResponse("<p>old</p>", 1));
    },
  });
  await c.getPage("852005", "storage", { version: 1 });
  assert.ok(seen[0].includes("version=1"), `version must reach the request, got ${seen[0]}`);
});

test("getPage reports which version it actually returned", async () => {
  // Otherwise a caller diffing two versions cannot confirm it got the ones it asked for.
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async () => response(200, pageResponse("<p>old</p>", 1)),
  });
  const p = await c.getPage("852005", "storage", { version: 1 });
  assert.equal(p.version, 1);
});

test("getPage omits the version parameter entirely when none is asked for", async () => {
  const seen = [];
  const c = new ConfluenceClient(CREDS, {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response(200, pageResponse("<p>current</p>"));
    },
  });
  await c.getPage("852005");
  assert.ok(!seen[0].includes("version="), `no version param expected, got ${seen[0]}`);
});

// ── getLinks (audit item 10) ──
//
// Reconstructing the link graph previously meant reading per-issue changelogs
// and replaying link-creation events one issue at a time. It did surface real
// problems — two hard-404 keys still hyperlinked from a live ticket, and a
// live `blocks` link pointing at one of them — but at far too many calls.
//
// Sources are resolved per key rather than by a bulk `key in (...)` query, for
// the same reason validateKeys is: a bulk query silently omits an unindexed
// issue, and a link graph missing a node is worse than no graph.

function linkIssue(key, links) {
  return { key, fields: { issuelinks: links } };
}

test("getLinks reports each link with its type, direction and target", async () => {
  const c = new AtlassianClient(CREDS, {
    fetchImpl: async (url) => {
      if (String(url).includes("/issue/OA-986")) {
        return response(200, linkIssue("OA-986", [
          { type: { name: "Blocks", outward: "blocks" }, outwardIssue: { key: "OA-897" } },
        ]));
      }
      return response(200, { issues: [{ key: "OA-897" }], isLast: true });
    },
  });

  const r = await c.getLinks(["OA-986"], { checkTargets: false });
  const link = r.results[0].links[0];
  assert.equal(link.type, "Blocks");
  assert.equal(link.direction, "outward");
  assert.equal(link.targetKey, "OA-897");
});

test("getLinks distinguishes inward from outward links", async () => {
  const c = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(200, linkIssue("OA-1", [
      { type: { name: "Blocks", inward: "is blocked by" }, inwardIssue: { key: "OA-2" } },
    ])),
  });
  const r = await c.getLinks(["OA-1"], { checkTargets: false });
  assert.equal(r.results[0].links[0].direction, "inward");
  assert.equal(r.results[0].links[0].targetKey, "OA-2");
});

test("getLinks flags a link whose target does not resolve", async () => {
  // The dangling-link case: a live ticket with a blocks link to a deleted issue.
  const c = new AtlassianClient(CREDS, {
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.includes("/issue/OA-1")) {
        return response(200, linkIssue("OA-1", [
          { type: { name: "Blocks", outward: "blocks" }, outwardIssue: { key: "OA-928" } },
        ]));
      }
      if (s.includes("/issue/OA-928")) return response(404, "gone");
      return response(200, { issues: [], isLast: true });
    },
  });

  const r = await c.getLinks(["OA-1"]);
  assert.equal(r.results[0].links[0].targetExists, false);
  assert.equal(r.danglingCount, 1);
});

test("getLinks marks a resolvable target as existing", async () => {
  const c = new AtlassianClient(CREDS, {
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.includes("/issue/OA-1")) {
        return response(200, linkIssue("OA-1", [
          { type: { name: "Relates", outward: "relates to" }, outwardIssue: { key: "OA-2" } },
        ]));
      }
      if (s.includes("/issue/OA-2")) return response(200, { key: "OA-2" });
      return response(200, { issues: [{ key: "OA-2" }], isLast: true });
    },
  });

  const r = await c.getLinks(["OA-1"]);
  assert.equal(r.results[0].links[0].targetExists, true);
  assert.equal(r.danglingCount, 0);
});

test("getLinks returns an entry for a source key with no links at all", async () => {
  // Absence of links must be visible, not indistinguishable from a dropped key.
  const c = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(200, linkIssue("OA-808", [])),
  });
  const r = await c.getLinks(["OA-808"], { checkTargets: false });
  assert.equal(r.results.length, 1);
  assert.deepEqual(r.results[0].links, []);
});

test("getLinks reports a source key it could not resolve rather than omitting it", async () => {
  const c = new AtlassianClient(CREDS, {
    fetchImpl: async () => response(404, "gone"),
  });
  const r = await c.getLinks(["OA-761"], { checkTargets: false });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].sourceVerdict, "not_found_or_no_permission");
});
