# Handoff: bridge changes downstream consumers should know about

**Date**: 2026-08-17
**Audience**: agents and humans working in `D:/UnrealProjects/5.6/OperationPhoenix` and
`D:/UnrealProjects/5.6/OnSight` (and `BreakOut2025` once it is wired).
**Upstream plan**: `docs/superpowers/plans/2026-08-17-mcp-bridge-audit-remediation.md`

These workspaces load the bridges **by path**, with no version pin, so changes take effect on the
next client restart. Nothing here requires a code change downstream; two items retire standing
misinformation, and the rest are new capability.

---

## 1. Stop inferring deletion from a missing key. Use `jira_validate_keys`.

**This is the item that matters.** A JQL `key in (...)` query returns only the keys it resolves. It
reports no error and does not say which inputs it dropped, so comparing counts and concluding "the
missing ones were deleted" is unsafe. It is wrong for three separate reasons, all verified live:

- The API returns the **same 404** for an issue that does not exist and one you may not read.
- An issue can be **missing from the search index** while fetching perfectly well by key. `OA-829` is
  in exactly this state: a live, Highest-priority ticket, invisible to a key query, an id query and
  text search. Sampling the range `OA-820`..`OA-845` found 20 searchable, 5 genuinely deleted, and
  1 alive-but-unindexed — roughly **1 in 21 live issues**.
- A rate-limited or failed request leaves a key's status **unknown**, which is not "absent".

```
jira_validate_keys(keys: ["OA-794", "OA-829", ...])
```

Returns exactly one verdict per input key, so omission is impossible. Verdicts: `exists`, `moved`,
`exists_not_searchable`, `not_found_or_no_permission`, `no_permission`, `rate_limited`, `error`. Each
response carries a `verdictMeaning` legend stating what the verdict does and does not license you to
conclude.

Note `not_found_or_no_permission` is deliberately hedged — do not shorten it to "deleted" in a
report. And `unresolved` counts keys whose state could not be established; treat those as unknown.

**Any reference-integrity or dangling-link check over Jira keys must use this tool**, not a
`key in (...)` query.

## 2. The `jira_search` 410 was never real. Ignore any note that says otherwise.

`jira_search` works, and has been re-verified in three query shapes including a 20-key batch that
returned all 20. The claim that it returns HTTP 410 originated in a handoff written from the consumer
side that was never run against the bridge.

- **No skill changes needed.** All five skills named in that handoff (`jira-status`, `jira-sync`,
  `triage-jira`, `triage`, `fill-invoice`) already call `jira_search` directly and carry no
  workaround.
- **Please delete** the memory entry
  `C:/Users/posne/.claude/projects/D--UnrealProjects-5-6-OperationPhoenix/memory/reference_jira_search_410_workaround.md`.
  It is the last live copy of the false claim.

## 3. Response shape changes — two Confluence tools

Both had **zero consumers** across all three workspaces (verified with an unrestricted file-type
sweep), so nothing should break. Listed so a future caller is not surprised.

| Tool | Was | Now |
|---|---|---|
| `confluence_space_pages` | bare array of pages | `{count, total, isLast, start, limit, pages}` |
| `confluence_list_spaces` | bare array of spaces | `{count, total, isLast, start, limit, spaces}` |

Both now accept `start` for paging. **Check `isLast`** — if false, call again with `start` advanced
by `limit`. `total` is `null` on purpose: the underlying API reports the size of the page it just
returned, not the size of the collection, and passing that off as a total is what made truncation
invisible in the first place.

### `confluence_list_spaces` was hiding your biggest space

Its type filter was documented as `'global'` or `'personal'`. The `PO` space ("Project OnSight",
**161 pages**, the largest on the instance) is type **`collaboration`** — neither documented value.
Filtering by either silently excluded it and returned a confident, complete-looking, wrong answer.
The filter now passes through any type the API accepts and defaults to no filter.

**If any prompt or skill filters spaces by type, drop the filter** unless you specifically want one
type.

## 4. New Perforce capability — shelves and cross-user queries

Previously a sweep that had to enumerate shelves could not be done through the bridge at all and
required raw CLI.

- `p4_changes(allUsers: true)` — drops the user filter, so other people's pending changelists are
  visible. Cannot be combined with `user`. **The default path is unchanged**, so existing calls are
  unaffected.
- `p4_describe(shelved: true)` — maps to `describe -S`, listing a pending changelist's shelved files.
  Without it the default output lists none of them.
- `p4_shelves(allUsers?, client?, maxChangelists?, onlyShelved?)` — every pending changelist with its
  owner, client, description and shelved file list, in one call.

One call across all users found the 55-file shelf on CL 3553 plus shelves owned by two other users.

**Read `depotScope` on the response.** The sweep is bounded by the bridge's configured depot
(`//Project1/Operation-Phoenix/...`), so `isLast: true` means complete *for that depot*, not for the
server. Shelves in other depots are out of range.

## 5. New Miro capability — generic passthrough

`miro_request(path, method?, queryParams?, bodyJson?)` reaches any Miro API path, including versions
outside the one the bridge normally targets.

**Known limitation, do not re-investigate:** `table`, `table_text` and `widgets_stack` items return
`content: null`. This is not a bridge defect — the API marks them unsupported and returns no data
object, and refuses them as a type filter. Every route was checked with the passthrough: the
single-item endpoint is equally empty, a v2 tables path does not exist, the experimental one returns
access-denied for a token with ordinary board scopes, and the legacy API returns the table under an
older name with only timestamps. **Table cell text is not retrievable by any available route.** If
you need that content, read it off the board by hand.

---

## Not a bridge matter, but worth someone's attention

`OA-829` is a live, Highest-priority ticket that is **invisible to every JQL query** on the instance.
No bridge change fixes that, and until it is repaired every search-driven tool under-reports. Worth
raising with a Jira admin — a project reindex is the usual remedy.
