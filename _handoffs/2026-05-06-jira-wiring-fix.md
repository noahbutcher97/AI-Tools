# Handoff: jira_search 410 -- wire searchIssues() as POST

> ## CLOSED 2026-08-17 -- NOT REPRODUCIBLE. Do not apply the fix below.
>
> `jira_search` works. It was exercised against the live bridge in three shapes,
> all returning HTTP 200 with a well-formed `{issues, nextPageToken, isLast}`:
>
> | Query | Result |
> |---|---|
> | `project = OA ORDER BY created DESC`, `maxResults=2` | 200, issues returned, `isLast: false` |
> | 20-key `key in (...)`, `maxResults=100` | 200, **20 of 20 keys returned**, `isLast: true` |
> | `key in (OA-829,OA-808)` | 200, `OA-808` returned |
>
> The current code calls `/rest/api/3/search/jql` with the default **GET**, and GET
> on that path succeeds. The root cause below -- "the endpoint is POST-only; GET
> returns 410" -- is either wrong or has been overtaken by an Atlassian change.
> **Applying the proposed patch would rewrite working code.**
>
> The downstream migration list in this document is also stale. All five named
> Operation-Phoenix skills were checked: every one already calls `jira_search`
> directly, none contains the `jira_request` workaround, and none carries a 410
> note. That work was either already done or never needed.
>
> ### Why this document was wrong for three months
>
> It was written from the consumer side, from a downstream diagnosis, and **was
> never executed against the bridge**. Its own closing section admits the handoff
> scaffold was skipped. Being specific, plausible and well-formatted, it was then
> trusted rather than re-checked -- it propagated into five skills and a stored
> memory entry, and a later remediation plan copied its migration list forward
> without verifying it either.
>
> The lesson, and the convention adopted because of it: **a handoff must mark each
> claim as executed or reasoned.** Nothing in this document distinguished
> "I ran this" from "I concluded this", which is precisely what let a confident
> wrong claim outlive its own subject matter.
>
> Remaining cleanup: the memory entry
> `.../D--UnrealProjects-5-6-OperationPhoenix/memory/reference_jira_search_410_workaround.md`
> still exists and should be deleted.
>
> See `docs/superpowers/plans/2026-08-17-mcp-bridge-audit-remediation.md`.

---

**Date**: 2026-05-06 (handoff scaffolded 2026-05-16 from downstream-consumer-side diagnosis)
**Bridge**: `MCP-Servers/bridges/atlassian/server.mjs` (jira-bridge-mcp v2.0.0)
**Status**: **CLOSED 2026-08-17 -- not reproducible (see banner above).** Previously: diagnosed, fix proposed, not applied.
**Severity**: ~~Medium~~ -- none; the reported defect does not exist.

---

## Symptom

Any call to the `jira_search` MCP tool returns:
```
Atlassian API 410: <html body or empty>
```

Reproduces in: any client that wires the local atlassian bridge (Claude Code in Operation-Phoenix workspace, Claude Desktop Cowork, any IDE wiring the same `.mcp.json` entry).

---

## Root cause

`server.mjs:116-135` migrated to the post-CHANGE-2046 endpoint `/rest/api/3/search/jql` correctly, but calls it with HTTP GET:

```js
// server.mjs:116-135 (current)
async searchIssues(jql, maxResults = 50, nextPageToken = null, fields = null) {
  // ... CHANGE-2046 comments ...
  const params = { jql, maxResults, fields: fields || "*all" };
  if (nextPageToken) params.nextPageToken = nextPageToken;
  const data = await this.request("/rest/api/3/search/jql", params);  // <-- defaults to GET
  // ...
}
```

`request()` at `server.mjs:86` defaults `method = "GET"`. `searchIssues()` does not override it, so the URL is hit with GET and query-string params.

**Atlassian's new endpoint `/rest/api/3/search/jql` is POST-only.** Per their Jira Cloud REST API reference, GET against this path returns 410 Gone -- they explicitly removed the GET method along with the old `/rest/api/3/search` path in CHANGE-2046 (April 2025). The bridge's URL migration is correct; the verb is wrong.

This is also why the `jira_request(path: "/rest/api/3/search/jql", method: "POST", bodyJson: {...})` workaround succeeds -- it passes POST explicitly, and `request()` at `server.mjs:101` correctly puts the body in the request body when method !== GET/DELETE.

---

## Fix (proposed -- not yet applied)

Replace `searchIssues()` body at `server.mjs:116-135`:

```js
async searchIssues(jql, maxResults = 50, nextPageToken = null, fields = null) {
  // Atlassian removed /rest/api/3/search in their April 2025 changelog
  // (CHANGE-2046). The replacement /rest/api/3/search/jql differs in three
  // material ways:
  //   1. It is POST-only -- GET returns 410.
  //   2. Pagination is token-based (nextPageToken), not offset-based
  //      (startAt). Response no longer includes `total` or `startAt`.
  //   3. The default `fields` set is now {id} only -- old endpoint
  //      returned the full *navigable set. We default to "*all" so the
  //      bridge's _formatIssue() keeps populating key/summary/status/etc.
  //      Callers can still pass an explicit field list to narrow the
  //      payload (e.g. ["summary", "status", "priority"] for terse summaries).
  const body = { jql, maxResults, fields: fields || "*all" };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const data = await this.request("/rest/api/3/search/jql", {}, "POST", body);
  return {
    issues: data.issues.map(i => this._formatIssue(i)),
    nextPageToken: data.nextPageToken || null,
    isLast: data.isLast === true,
  };
}
```

Change summary: pass `params={}` (no query string), `method="POST"`, and the previous `params` content as `body`. The existing `request()` helper at `server.mjs:86-109` already handles POST-with-body correctly (line 101: `if (body && method !== "GET" && method !== "DELETE") opts.body = JSON.stringify(body);`).

**`fields` parameter shape**: Atlassian's POST endpoint accepts `fields` as either a comma-separated string (`"*all"`, `"summary,status"`) or a JSON array (`["summary", "status"]`). The current default string `"*all"` continues to work in POST body. No change needed unless you want to switch defaults to arrays.

---

## Verification steps after applying

1. Apply the patch.
2. Restart any client wired to the bridge (Claude Code session, Claude Desktop). MCP stdio servers do not hot-reload.
3. From a fresh client session:
   ```
   mcp__atlassian__jira_search(jql: "project = OS AND assignee = currentUser() ORDER BY priority DESC")
   ```
   Should return `{ issues: [...], nextPageToken: ..., isLast: bool }` instead of 410.
4. Verify token-based pagination round-trip: call once, capture `nextPageToken`, call again with that token, confirm a different page is returned.
5. Verify explicit `fields` narrowing works: pass `fields: "summary,status"` and confirm response only carries those.

---

## Downstream impact -- consumers to revert to typed tool after fix

The Operation-Phoenix project (`D:/UnrealProjects/5.6/OperationPhoenix/`) currently routes around this bug in five skills under `.claude/skills/`. Once the bridge fix ships, those skills can revert to the simpler `jira_search` call shape.

Files that call `jira_request(path: "/rest/api/3/search/jql", method: "POST", bodyJson: {...})` solely as a 410 workaround:

| Skill | File |
|---|---|
| `jira-status` | `.claude/skills/jira-status/SKILL.md` (three queries) |
| `jira-sync` | `.claude/skills/jira-sync/skill.md` (Step 3, two queries) |
| `triage-jira` | `.claude/skills/triage-jira/SKILL.md` (Step 1) |
| `triage` | `.claude/skills/triage/SKILL.md` (Agent 1 dispatch prompt) |
| `fill-invoice` | `.claude/skills/fill-invoice/SKILL.md` (Step 9 worklog query) |

Each of these has a comment block citing memory `reference_jira_search_410_workaround` and this handoff. When this handoff is closed, the workaround comments can be removed and the calls simplified back to `jira_search(jql: "...")`.

The Operation-Phoenix memory at `C:/Users/posne/.claude/projects/D--UnrealProjects-5-6-OperationPhoenix/memory/reference_jira_search_410_workaround.md` should also be updated or deleted once the fix is verified.

---

## Other bridge tools to audit while you're in here

The same GET-vs-POST mistake could exist on other Atlassian endpoints that were migrated alongside CHANGE-2046. Confluence's `cql` content search is one to verify -- check whether `confluence_search` at `server.mjs:284-287` (uses `/wiki/rest/api/content/search`) is on a list of endpoints with similar method changes. Atlassian's changelog page is the source of truth.

A grep across the bridge for `this.request(` calls that hit POST-only endpoints with default-GET method is a one-pass check:

```bash
grep -nE "this\.request\(\"/rest" MCP-Servers/bridges/atlassian/server.mjs
```

Cross-reference each path against the current Jira REST API docs (https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/).

---

## Why the handoff doc didn't exist until now

The downstream memory entry `reference_jira_search_410_workaround` (in the Operation-Phoenix project's local memory store) references this file path as the canonical handoff. The file was never written -- the downstream workaround was put in place but the upstream handoff scaffold was skipped. This document is the missing scaffold, authored 2026-05-16 from a downstream-side root-cause diagnosis. The 2026-05-06 date in the filename is preserved to match the existing memory reference.
