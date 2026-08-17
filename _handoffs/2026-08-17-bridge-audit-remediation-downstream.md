# Handoff: bridge changes downstream consumers should know about

**Date**: 2026-08-17 (revised same day — now covers all three passes, not just the first)
**Audience**: agents and humans working in `D:/UnrealProjects/5.6/OperationPhoenix` and
`D:/UnrealProjects/5.6/OnSight` (and `BreakOut2025` once it is wired).
**Upstream plan**: `docs/superpowers/plans/2026-08-17-mcp-bridge-audit-remediation.md`

These workspaces load the bridges **by path**, with no version pin, so changes take effect on the
next client restart.

---

## 1. Stop inferring deletion from a missing key. Use `jira_validate_keys`.

**This is the item that matters.** A JQL `key in (...)` query returns only the keys it resolves. It
reports no error and does not say which inputs it dropped, so comparing counts and concluding "the
missing ones were deleted" is unsafe. It is wrong for three separate reasons, all verified live:

- The API returns the **same 404** for an issue that does not exist and one you may not read.
- An issue can be **missing from the search index** while fetching perfectly well by key. `OA-829` is
  in exactly this state: a live, Highest-priority ticket, invisible to a key query, an id query and
  text search. Sampling `OA-820`..`OA-845` found 20 searchable, 5 genuinely deleted, and 1
  alive-but-unindexed — roughly **1 in 21 live issues**.
- A rate-limited or failed request leaves a key's status **unknown**, which is not "absent".

```
jira_validate_keys(keys: ["OA-794", "OA-829", ...])
```

Returns exactly one verdict per input key, so omission is impossible. Verdicts: `exists`, `moved`,
`exists_not_searchable`, `not_found_or_no_permission`, `no_permission`, `rate_limited`, `error`. Each
response carries a `verdictMeaning` legend.

`not_found_or_no_permission` is deliberately hedged — **do not shorten it to "deleted"** in a report.
`unresolved` counts keys whose state could not be established; treat those as unknown, not absent.

**Any reference-integrity check over Jira keys must use this tool**, not a `key in (...)` query.

## 2. `jira_get_links` — the link graph, with dangling detection

```
jira_get_links(issueKeys: [...], checkTargets: true)
```

Returns each issue's links with type, direction and target, plus `targetExists` per target and a
`danglingCount`. Replaces reconstructing the graph from per-issue changelogs.

Sources are resolved per key rather than by a bulk query, for the reason in §1 — verified live, where
`OA-829` returned its link correctly and a bulk query would have dropped it.

**Scope limit, read this before using it for integrity checks:** it covers Jira **issue links**. Jira
removes those when an issue is deleted, so dangling link objects are rare — a 30-issue sweep found 88
links and **zero** dangling. A hyperlink to a dead issue **inside a description or comment** is plain
text, not a link object, and is **not detected here**. That was the audit's actual finding
(`OA-928`, `OA-937` — both still 404). To catch that class, extract keys from body text yourself and
pass them to `jira_validate_keys`.

## 3. The `jira_search` 410 was never real. Ignore any note that says otherwise.

`jira_search` works, re-verified in three query shapes including a 20-key batch that returned all 20.
The claim originated in a handoff written from the consumer side that was never run against the
bridge.

- **No skill changes needed.** All five skills named in that handoff already call `jira_search`
  directly.
- The stale memory entry `reference_jira_search_410_workaround.md` has been **deleted**.

## 4. Response shape changes

All had **zero or one** verified consumer, so little should break. Listed so nothing surprises you.

| Tool | Was | Now |
|---|---|---|
| `confluence_space_pages` | bare array | `{count, total, isLast, start, limit, pages}` |
| `confluence_list_spaces` | bare array | `{count, total, isLast, start, limit, spaces}` |
| `confluence_search` | `{total, results}` | `{count, total, isLast, start, limit, results}` |
| `miro_get_board_items` | `{items, cursor, total}` | `{count, total, isLast, items, cursor}` |
| `miro_get_connectors` | bare array | `{count, total, isLast, connectors, …}` |
| `p4_shelves`, `miro_get_all_board_items` | new | same envelope |

**Always check `isLast`.** A page whose length equals its limit is otherwise indistinguishable from a
complete result — that single ambiguity caused three wrong conclusions in the audit.

`total: null` is deliberate and honest. Confluence v1 endpoints report the size of the page they just
returned, not the size of the collection; publishing that as a total is what made truncation
invisible. Miro **does** supply a real total, so those tools carry one.

Note on `confluence_search`: the previous code read a `totalSize` field this endpoint **does not
send**, so its reported total had always been `undefined`. If anything downstream reads that, it was
already broken.

### `confluence_list_spaces` was hiding your biggest space

Its type filter was documented as `'global'` or `'personal'`. The `PO` space ("Project OnSight",
**161 pages**, the largest on the instance) is type **`collaboration`** — neither documented value.
Filtering by either silently excluded it and returned a confident, complete-looking, wrong answer.
The filter now passes through any type the API accepts and defaults to no filter.

**If any prompt or skill filters spaces by type, drop the filter** unless you specifically want one.

## 5. Reading Confluence pages: text, sections, versions

```
confluence_get_page(pageId, format: "text", section: "Aura Tiers", version: 3)
```

- **`format: "text"`** strips markup server-side. Large pages are mostly macro and attachment
  wrappers — 12,964 → 3,782 characters on a sampled page. Response reports `bodyLength` **and**
  `rawBodyLength`. **Stop writing client-side HTML stripping.**
- **`section`** returns one heading's subtree (152 characters vs 3,782 on that page). A section runs
  to the next heading of the same or shallower level. A heading matching more than one on the page
  reports `matchCount` and `ambiguous` rather than guessing; a heading matching nothing returns
  `found: false` with `availableHeadings` and does **not** fall back to the whole page.
- **`version`** fetches a historical revision, so "did this text exist at version N-1?" is answerable
  by fetching two and comparing.

## 6. Perforce: shelves and cross-user queries

- `p4_changes(allUsers: true)` — drops the user filter. Cannot be combined with `user`. **The default
  path is unchanged**, so existing calls are unaffected.
- `p4_describe(shelved: true)` — `describe -S`; without it the output lists no shelved files.
- `p4_shelves(allUsers?, client?, maxChangelists?, onlyShelved?)` — every pending changelist with
  owner, client, description and shelved files, in one call. Found the 55-file shelf on CL 3553 plus
  two other users' shelves.

**Read `depotScope` on the response.** The sweep is bounded by the configured depot
(`//Project1/Operation-Phoenix/...`), so `isLast: true` means complete *for that depot*, not for the
server.

## 7. Miro: whole boards, readable graphs, and an escape hatch

- `miro_get_all_board_items(boardId, maxPages?)` — pages internally. **Use this instead of
  hand-managing cursors**: 322 items in one call where the per-page cap is 50. Reports `truncated` if
  the page budget bites.
- `miro_get_connectors(boardId, resolveEndpoints: true)` — inlines each endpoint's type and text, so
  the dependency graph reads as `Acceptance Criteria → Expected Level of Quality` instead of bare IDs.
- `miro_request(path, method?, queryParams?, bodyJson?)` — any Miro API path, including versions
  outside the one the bridge targets.

### Connectors without endpoints: the ambiguity is resolved

Some connectors return no endpoints. They are **not** unattached, and the bridge is **not** dropping
fields — the API marks them `isSupported: false` and declines to serialize them, the same marker it
uses for table items. On `Milestone 2 Plan`, 9 of 30 are in this state.

The reason now travels with each connector as `endpointsUnavailable`. Separately, an endpoint marked
`unresolved` was simply **not reached** because the board sweep hit its page budget — check
`endpointLookupComplete`. Three distinct states, all now distinguishable.

### Known limitation — do not re-investigate

`table`, `table_text` and `widgets_stack` items return `content: null`. This is not a bridge defect.
Every route was checked with the passthrough: the single-item endpoint is equally empty, a v2 tables
path does not exist, the experimental one returns access-denied for a token with ordinary board
scopes, and the legacy API returns the table under an older name with only timestamps. **Table cell
text is not retrievable by any available route.** Read it off the board by hand.

Shapes, sticky notes and frames **do** return their text — as HTML, which `format`-style text
conversion now handles inside the connector endpoint resolution.

---

## Not a bridge matter, but worth someone's attention

`OA-829` is a live, Highest-priority ticket that is **invisible to every JQL query** on the instance.
No bridge change fixes that, and until it is repaired every search-driven tool under-reports. Worth
raising with a Jira admin — a project reindex is the usual remedy.
