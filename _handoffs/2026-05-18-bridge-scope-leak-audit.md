# Bridge scope-leak audit — 2026-05-18

**Status update 2026-05-18**: All three findings below have been addressed.
Findings #1 and #2 are *mitigated* (scope warning surfaced in response,
non-breaking) rather than *eliminated* (would require making the filter
mandatory and breaking existing callers). Finding #3 is fully resolved.

Motivated by the Perforce default-CL preview bug (workspace-wide `p4 opened`
when caller asked for default-CL only). Audited Atlassian and Miro bridges
for the same pattern: optional resource-scope params that, when omitted,
operate broader than the caller likely intends.

## Findings

### 🟡 SCOPE-LEAK #1 — `jira_list_boards` (atlassian/server.mjs:474) — MITIGATED 2026-05-18

**Behavior**: `projectKey` is optional. When omitted, the client calls
`/rest/agile/1.0/board` with no `projectKeyOrId` query param, returning
**every agile board in the Atlassian instance** the credential can see —
not just the project the agent is working on.

**Code**:
```js
async listBoards(projectKeyOrId) {
  const params = {};
  if (projectKeyOrId) params.projectKeyOrId = projectKeyOrId;
  const data = await this.request("/rest/agile/1.0/board", params);
  ...
}
```

**Why this matters**: an agent that calls `jira_list_boards` to enumerate
"the boards in my project" silently gets boards from every other project too.
Downstream calls (e.g. `jira_list_sprints` on a returned board ID) can land
on the wrong project's sprints. Listings aren't sensitive, but the picture
the agent forms is wrong, in the same way today's Perforce preview was
showing files from CL 2224.

**Recommended fix**: tighten the schema. Either
- (a) make `projectKey` required (breaking change, but clearest);
- (b) keep optional but rename/document explicitly — change the description
      from "optionally filtered by project" to "OMITTED = ENTIRE INSTANCE";
      add a soft warning in the response when omitted; or
- (c) require a `confirmListAll: true` flag when `projectKey` is absent.

### 🟡 SCOPE-LEAK #2 — `miro_list_boards` (miro/server.mjs:288) — MITIGATED 2026-05-18

**Behavior**: `teamId` is optional. When omitted, the client calls
`/v2/boards` with no `team_id`, returning **every board the access token
has access to across all teams**.

**Code**:
```js
async listBoards(teamId = null, query = null, limit = 50) {
  const params = { limit };
  if (teamId) params.team_id = teamId;
  if (query) params.query = query;
  ...
}
```

**Why this matters**: same shape as #1. Agents asking "what boards exist
for this team" will get other teams' boards mixed in.

**Recommended fix**: same options as #1.

### 🔴 UNRELATED CORRECTNESS BUG — `jira_dashboard_export` (atlassian/server.mjs:529) — RESOLVED 2026-05-18

Surfaced incidentally during the audit. Not a scope leak — a broken
pagination loop after the post-CHANGE-2046 endpoint migration (commit
5daa44e).

**The problem**:
```js
while (startAt < maxResults) {
  const batch = await client.searchIssues(
    `project = "${projectKey}" ORDER BY rank ASC`,
    Math.min(100, maxResults - startAt),
    startAt,                              // ← passed as nextPageToken!
  );
  all.push(...batch.issues);
  if (all.length >= batch.total || ...)  // ← batch.total no longer exists
    break;
  startAt += batch.issues.length;
}
```

After the migration, `searchIssues`'s third arg is `nextPageToken` (a string
cursor from the previous response), and the response no longer includes
`total` or `startAt`. The loop:
- passes the integer `startAt` where a token string is expected — Atlassian
  will either ignore it or 400 on the second iteration;
- reads `batch.total` which is `undefined`, so the loop breaks early or
  loops indefinitely depending on which condition fires first;
- never reads `batch.nextPageToken` to advance the cursor.

In practice the function likely returns only the first page and may stop
prematurely.

**Recommended fix**: rewrite the loop using the new pagination contract:
```js
let token = null;
do {
  const batch = await client.searchIssues(jql, 100, token);
  all.push(...batch.issues);
  if (all.length >= maxResults || batch.isLast) break;
  token = batch.nextPageToken;
} while (token);
```

## What was checked and judged safe

All the rest. The vast majority of tools require a primary resource ID
(`issueKey`, `pageId`, `boardId`, `spaceKey`, `sprintId`) — no scope to leak.
A handful of optional filters (`type` on `confluence_list_spaces`, `type` on
`miro_get_board_items`, `parentId` on item-creation tools) are correctly
additive: omission means "all types under the already-scoped resource", not
"workspace-wide".

`jira_search` and `confluence_search` take user-supplied JQL/CQL with no
project/space prepending. Not classified as a leak because the query string
IS the scope — the agent wrote what it wrote — but worth flagging for future
prompt-side conventions.

## Applied fixes (2026-05-18)

1. **`jira_dashboard_export` pagination — resolved.** Loop rewritten to use
   `nextPageToken` and `isLast` per the new endpoint contract. References to
   the removed `startAt`/`total` are gone.
2. **`jira_list_boards` / `miro_list_boards` — mitigated.** Chose option (c)
   (warning in output) over (a) (require resource ID) to avoid breaking
   existing callers. The response is now wrapped with `scope` and (when
   unscoped) `warning` fields, so an agent reading the JSON gets explicit
   signal about what it's looking at. Existing data still flows through —
   nothing breaks.

## Convention worth adopting going forward

Any tool whose unscoped form crosses a resource boundary should either:
- require the scope param (breaking), or
- wrap its response with `scope` + `warning` fields so the caller can
  detect cross-boundary reads without reading the tool description.

The `scope` field convention is the lighter-touch choice. Use it whenever
the underlying API silently broadens scope on missing filters.
