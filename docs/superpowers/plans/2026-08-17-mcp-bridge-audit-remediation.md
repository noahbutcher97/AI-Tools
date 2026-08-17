# MCP Bridge Audit Remediation — Implementation Plan

**Date**: 2026-08-17
**Source**: Cross-surface consistency audit (Jira / Confluence / Miro / Otter / Perforce / source / local docs)
run against the OnSight + Operation-Phoenix workspace. Three passes, several hundred tool calls.
**Scope of this plan**: Items 1–6 of the audit's 11-item list (the P0 and P1 blocks). Items 7–11 are
recorded at the end as deferred, not dropped.
**Status**: Verified, designed, NOT yet implemented.
**Revision**: 3 (2026-08-17). Revision 1 was reviewed against evidence (corrected four inherited
claims, found three bugs the audit missed, added four structural items — V10–V16). Revision 3 then
closed every remaining unknown before lock-in (V17–V22) and **retracted one of Revision 2's own
corrections**, which had been produced by a truncating probe. See Review Corrections.

**Lock-in status**: all blocking unknowns closed (V17–V24). One non-blocking unknown remains
(item 3(b), answerable only once the passthrough exists).

**Approval state — APPROVED, all 9 tasks (2026-08-17).** The requester approved audit items 1–6 with
a checkpoint (Tasks 1–7), then approved Tasks 8 and 9 after they were presented with the V13/V14 and
V18 evidence behind them.

### Execution status

| Task | State | Evidence |
|---|---|---|
| **5 — `p4_changes(allUsers)`** | **DONE** | Suite 131 → 137 green. Live: returns `jshaun@OA_Hook_DT` CL 3564; default path byte-identical; `allUsers`+`user` rejected with `isError`. |
| **4 — shelves** | **DONE** | Suite → 148 green. Live: `p4_shelves(allUsers)` returns CL 3553 with **55 files** in one call across `noah`/`jshaun`/`klara`; `p4_describe(shelved)` yields 55 vs 0 without. |
| **1 — `jira_validate_keys`** | **DONE** | Atlassian bridge went from 0 to 15 tests. Live: the audit's own key set returns `OA-829 → exists_not_searchable`, four keys `not_found_or_no_permission`, `OA-808 → exists`. |
| 2, 3, 6, 7, 8, 9 | not started | — |

Suites: perforce **148/148**, atlassian **15/15** (from zero). No regressions at any step.

### Task 1 notes

- **The client extraction was done as its own commit before any behavior change**, per the risk
  sequencing above. Proof it was inert: the complete tool surface (every name, description and input
  schema for all 35 tools) was captured before and after and is byte-identical by SHA; eight
  read-only tools across both clients were then exercised live.
- **Searchability costs N+1 calls, not 2N.** The plan proposed a per-key search probe. Implemented
  instead as one bulk `key in (...)` query per 50 resolved keys, diffed against the fetch-confirmed
  set — same signal, far cheaper. That query is itself paged, so a full page is never read as
  complete.
- **`checkSearchable` defaults ON**, per the plan's recommendation. The `exists_not_searchable` case
  is the one that silently corrupts reference-integrity checks, so detecting it by default is the
  point of the tool.
- **The response ships a `verdictMeaning` legend** stating what each verdict does *and does not*
  license a caller to conclude — particularly that a 404 cannot be read as "deleted" and that
  `rate_limited` / `error` mean unknown, never absent.

### Still open on the Atlassian bridge

`ConfluenceClient` was extracted but does **not** yet take an injected fetch and does not attach
`err.status`. Tasks 6 and 8 need both. Do that as the first step of whichever lands first.

Implementation notes worth carrying forward:

- **CRLF.** The live server emits `\r\n`. `parseDescribeShelved` splits on `/\r?\n/` (the established
  idiom in this file); a naive `split("\n")` corrupts the trailing action token to `"add\r"`. There is
  an explicit regression test for this.
- **Two shapes on `p4_changes`, deliberately.** The default path still returns raw text — 23 skills
  depend on it. Only the new `allUsers` path returns the `scope`/`warning` JSON wrapper. Since no
  existing caller passes `allUsers`, this honors the scope convention while breaking nothing.
- **`depotScope` added to `p4_shelves`.** Live checking showed the sweep inspects 7 changelists while
  the server has 16 pending, because the bridge is scoped to `//Project1/Operation-Phoenix/...`.
  `isLast: true` was therefore true-but-misleading. The response now names its depot boundary so a
  caller cannot read it as server-wide. **This is the audit's own cross-cutting principle catching a
  defect inside the audit's own fix.**

**Execution order — Perforce first (Tasks 5 then 4), by requester decision.** Rationale: fully
verified (V7, V21), purely additive with zero shape breakage, and `buildChangesArgs` is already a
pure, tested function — the cleanest TDD target and the lowest-risk way to establish the test rhythm
before touching the untested Atlassian monolith.

---

## Why this document exists

The audit's item 2 (`jira_search` returns 410) is a false finding that has been circulating in this
repo since 2026-05-06. It was diagnosed once from the consumer side, written into
`_handoffs/2026-05-06-jira-wiring-fix.md`, propagated into five Operation-Phoenix skills and one
memory entry — and **never verified against the bridge**. It is not reproducible today (see
Verification Log, V4).

That is the failure mode this plan is written to avoid. Every claim below is tagged with how it was
established: `VERIFIED` (a command was run and its output is recorded), `ASSUMED` (reasoning from
source, not executed), or `OPEN` (unknown, needs a decision or an experiment).

---

## Verification Log

Everything in this section was executed on 2026-08-17 against live systems.

### V1 — Bridge locations `VERIFIED`

All bridges are siblings under `MCP-Servers/bridges/`:

```
atlassian/  discord/  miro/  otter/  perforce/
```

The audit assumed `miro` and `perforce` were siblings of `atlassian` but flagged it unverified. They are.

`discord/` and `otter/` exist on disk but are **vestigial**: Discord has no bot authorization and
cannot be installed; Otter is superseded by the provider-hosted MCP (`mcp__claude_ai_Otter_ai__*`).
Neither is in scope. Do not modify them under this plan.

### V2 — Consumers load these bridges by path, with no version gate `VERIFIED`

| Workspace | `.mcp.json` entries pointing at this repo |
|---|---|
| `D:/UnrealProjects/5.6/OperationPhoenix` | `atlassian`, `perforce`, `miro` |
| `D:/UnrealProjects/5.6/OnSight` | `perforce` |

All entries are `node D:/DevTools/AI-Tools/MCP-Servers/bridges/<name>/server.mjs`. There is no
installed copy, no package version, and no pin. **Every edit to this repo ships to those workspaces
on their next client restart.** This is the single most important constraint on the work.

`BreakOut2025` consumes the Perforce bridge too but is blocked on a separate BKGDev login and is
not currently wired.

### V3 — Test baseline `VERIFIED`

```
$ cd MCP-Servers/bridges/perforce && node --test
# tests 131 / pass 131 / fail 0
```

`perforce` splits `parsers.mjs` + `parsers.test.mjs` + `server.test.mjs`. `otter` splits
`client.mjs` + `client.test.mjs`. **`atlassian` (35 tools, ~1100 lines) and `miro` (17 tools) are
monolithic `server.mjs` files with zero tests.** Test runner is `node --test`.

### V4 — Item 2 (`jira_search` 410) does NOT reproduce `VERIFIED`

Three shapes were run through the live bridge over stdio, all returning HTTP 200 with well-formed
`{issues, nextPageToken, isLast}`:

| Query | Result |
|---|---|
| `project = OA ORDER BY created DESC`, `maxResults=2` | 200, issues returned, `isLast: false` |
| 20-key `key in (...)`, `maxResults=100` (audit's shape) | 200, **20 of 20 keys returned**, `isLast: true` |
| `key in (OA-829,OA-808)` | 200, `OA-808` returned |

The current code at `atlassian/server.mjs:128-130` calls `/rest/api/3/search/jql` with the default
**GET** method. GET on that path works. The handoff's root cause ("the endpoint is POST-only; GET
returns 410") is **wrong or has been overtaken by an Atlassian change**.

**Consequence**: item 2 needs no code change. Its deliverable is retiring the folklore. See Task 2.

### V5 — Item 1 reproduces, but the mechanism is not what the audit inferred `VERIFIED`

The audit inferred that keys absent from a bulk `key in (...)` result were deleted, and found that
inference wrong for `OA-829`. Confirmed, and the actual cause is a third failure mode that neither
the audit nor the initial design anticipated.

```
key in (OA-829)                      -> issues: []          (no error, isLast: true)
key in (OA-829,OA-808)               -> only OA-808         (OA-829 silently absent)
key in (OA-829,OA-761,OA-767,
        OA-774,OA-832)               -> issues: []          (no error, isLast: true)

GET /rest/api/3/issue/OA-829         -> 200, live issue
                                        id 15104, project OA (Optimum-Athena),
                                        type Engineering, status "To Do",
                                        priority Highest,
                                        summary "Input Buffer - P0 combat input queuing"

id = 15104                           -> issues: []
project = OA AND key = OA-829        -> issues: []
project = OA AND summary ~ "Input Buffer"  -> returns OA-753, OA-342, OA-337 — NOT OA-829
```

**OA-829 is absent from Jira's search index entirely** — unreachable by key, by id, and by text —
while fully alive over REST. It is not deleted, not moved, and not permission-restricted.

This strengthens the case for the audit's preferred fix (a): a per-key `GET /issue/{key}` fan-out is
the *only* route that sees this issue. A JQL-diffing approach (option b) would report `OA-829` as
missing and be wrong in exactly the way that started this.

### V6 — `no_permission` is NOT reliably distinguishable from `not_found` `VERIFIED`

```
GET /rest/api/3/issue/OA-761
  -> HTTP 404
     {"errorMessages":["Issue does not exist or you do not have permission to see it."],"errors":{}}
```

Jira Cloud deliberately conflates "does not exist" and "you may not see it" on this endpoint to
avoid leaking issue existence to unauthorized callers. **The audit's requested four-way verdict
(`exists` / `not_found` / `no_permission` / `moved`) cannot be honestly delivered as specified.**
See Task 1 for the revised vocabulary.

### V7 — Items 4 and 5 (Perforce) `VERIFIED`

```
$ p4 changes -s pending -m 5
Change 3564 ... by jshaun@OA_Hook_DT *pending* 'OA-909 safety shelf: full recon'
Change 3553 ... by noah@noah_OperationPhoenix *pending* ...
...

$ p4 changes -s pending -m 5 -u noah
  (3564 absent — confirms the -u filter is what hides cross-user work)

$ p4 changes -s pending -m 5 //Project1/...
  (3564 still present — depot-root scoping does NOT re-apply a user filter)

$ p4 describe -S -s 3564
Change 3564 by jshaun@OA_Hook_DT on 2026/08/12 14:08:38 *pending*
        OA-909 safety shelf: full reconnect chain working state ... Not for submit.
Shelved files ...
... //Project1/Operation-Phoenix/.../OSRejoinSave.cpp#1 add
    (9 shelved file lines)
```

Both capabilities work at the CLI and are compatible with the bridge's existing argument
construction (`buildChangesArgs` appends `-m <max> <depotRoot>`). `p4` is authenticated as
`noah` / client `noah_OperationPhoenix`.

Note: CL 3564 is a cross-user pending shelf that the default `p4_changes` call cannot see — the
exact class of finding the audit's process rule requires.

### V8 — Item 6 (Confluence pagination) `VERIFIED`

`confluence_space_pages` uses Confluence **v1** (`/wiki/rest/api/content`). Raw envelope:

```json
{ "start": 0, "limit": 5, "size": 0, "_links": { "base": "..." } }
```

- `start` **is** supported as a query parameter — offset pagination is available.
- `size` is the count returned in *this page*, not a collection total.
- `_links.next` appears only when more results exist — this is the reliable `isLast` signal.
- There is **no true total** on this endpoint.

Confluence **v2** is also reachable (`/wiki/api/v2/spaces` returns space ids, e.g. `MFS` -> `229380`)
and offers cursor pagination via `/wiki/api/v2/spaces/{id}/pages`. Still no total.

Incidental: the instance has exactly one global space, `MFS`, and
`confluence_space_pages(spaceKey: "MFS")` currently returns **0 pages**. The audit's 100-row
truncation was therefore observed against some other space. This does not change the design but
means the fix must be validated against a space with >100 pages before the acceptance criterion can
be signed off. `OPEN` — see Open Questions.

### V9 — Blast radius of response-shape changes `VERIFIED`

Skills referencing each tool, counted across all three consumer workspaces:

| Tool | OperationPhoenix | OnSight | BreakOut2025 | Total | Returns |
|---|---|---|---|---|---|
| `p4_changes` | 14 | 8 | 1 | **23** | raw CLI text |
| `p4_describe` | 12 | 9 | 2 | **23** | raw CLI text |
| `jira_search` | 7 | 0 | 0 | 7 | already `{issues, nextPageToken, isLast}` |
| `jira_request` | 7 | 0 | 0 | 7 | passthrough |
| `miro_get_connectors` | 1 | 0 | 0 | 1 | JSON list |
| `miro_get_board_items` | 0 | 0 | 0 | **0** | JSON list |
| `confluence_space_pages` | 0 | 0 | 0 | **0** | bare JSON array |
| `confluence_search` / `_list_spaces` | 0 | 0 | 0 | **0** | JSON |
| `jira_list_projects` / `_list_epics` / `_get_users` | 0 | 0 | 0 | **0** | JSON |

**The decisive finding**: the two tools carrying the entire downstream footprint return *raw `p4`
text*, not JSON lists, so the `total`/`isLast` envelope does not apply to them at all — and items 4
and 5 are purely additive. Every tool that genuinely needs an envelope has **zero or one** consumer.

The approved "clean envelope everywhere, accept the breakage" decision therefore costs far less than
it appeared to. It lands almost entirely on unconsumed surface.

### V10 — RETRACTED. The audit's Miro board attribution was CORRECT `VERIFIED`

**Revision 2 of this plan claimed the audit misattributed the board. That claim was wrong and is
withdrawn.** It was produced by a truncating verification probe (2500-char cap) that silently cut the
item list — the same defect class this plan exists to fix, committed by the plan's own tooling.

Correct data, from an untruncated read:

| Board | id | total items | table | table_text |
|---|---|---|---|---|
| `Long Term Sever Plan` | `uXjVHy-F0UY=` | **264** | 1 | **39** |
| `Milestone 2 Plan` | `uXjVH0xnoI8=` | 266 | 1 | 47 |
| `Feature Road Map - Planning` | `uXjVH2lq4Zw=` | 46 | 0 | 0 |

`Long Term Sever Plan` holds the table exactly as the audit reported, **and** is the 264-item board
referenced in deferred item 9. Both audit claims stand.

**Methodological note worth keeping**: a truncated read produced a confident, specific, wrong
correction to a correct report. Any future verification of a list surface must confirm it read the
whole list before drawing a negative conclusion.

### V17 — Miro serializes nothing for three item types, and says so `VERIFIED`

Raw v2 API for a `table_text` item on `Long Term Sever Plan`:

```json
{ "id": "3458764680644582698", "type": "table_text",
  "geometry": {...}, "position": {...}, "links": {...},
  "isSupported": false,
  "createdAt": "...", "modifiedAt": "..." }
```

There is **no `data` field at all**, and Miro explicitly flags `isSupported: false`. The bridge is not
dropping content — Miro does not serialize it. `miro_get_item` on the same id returns
`content: null`, matching.

Affected types found so far: **`table`, `table_text`, `widgets_stack`** (the last on
`Feature Road Map - Planning`, 1 of 46 items, also `content: null`). The fix must not be
table-specific.

Also: `GET /v2/boards/{id}/items?type=table_text` is **rejected with an API error** — undocumented
types cannot even be filtered for, which is why enumerating them requires reading every page.

### V18 — Miro DOES expose `total` and a cursor; the bridge already passes them through `VERIFIED`

```
GET /v2/boards/{id}/items?limit=50  ->  { "size": 50, "limit": 50, "total": 264, "cursor": "..." }
bridge miro_get_board_items(limit:50) -> 50 items + "cursor" + "total": 264
```

Unlike Confluence v1 (V8, no total), Miro supplies a real `total`. Deferred item 9 is therefore an
**ergonomics** problem (hand-managing the cursor), not a correctness one — the completeness signal is
already present. This also means the Task 9 envelope can carry a genuine `total` for Miro.

Counter-example on the same bridge: `miro_get_connectors` returns a **bare JSON array** with no
envelope at all — no total, no cursor, no isLast. It is the strongest argument for Task 9.

### V19 — Task 6 acceptance demonstrated end-to-end `VERIFIED`

Space `PO` ("Project OnSight"), 161 pages, via v1 with `start`:

| call | start | limit | size | `_links.next` | implies |
|---|---|---|---|---|---|
| page 1 | 0 | 100 | **100** | **present** | `isLast: false` |
| page 2 | 100 | 100 | 61 | **absent** | `isLast: true` |

100 + 61 = 161, matching the independent count. This is the audit's cross-cutting principle in one
table: page 1's `size == limit` is indistinguishable from a complete result **except** for the `next`
link. Task 6 is fully specified and demonstrable.

### V20 — `moved` is unreachable on this instance; 403 is not reproducible `VERIFIED`

`jira_list_projects` returns exactly **one** project: `OA` ("Optimum-Athena"). With a single project,
cross-project key moves cannot occur, so the `moved` verdict has no reachable test case here — it is
not merely untested, it is currently impossible to trigger.

Combined with V6 (Jira returns 404, not 403, and conflates missing with forbidden), neither `moved`
nor `no_permission` can be exercised on this instance.

**Decision**: keep both in the vocabulary — each is a two-line check that costs nothing and will be
correct if the instance ever grows a second project or returns a 403 — but document them in the tool
description as **defensive and unexercised**, so no caller treats their absence as meaningful.

### V21 — The audit's 55-file shelf located `VERIFIED`

Sweeping `p4 describe -S -s` across the 20 most recent pending changelists:

| CL | shelved files | owner |
|---|---|---|
| **3553** | **55** | `noah@noah_OperationPhoenix` |
| 1565 | 33 | — |
| 2848 | 12 | — |
| 3564 | 9 | `jshaun@OA_Hook_DT` |
| 3057 | 9 | — |

The 55-file shelf is **CL 3553**, and it belongs to `noah`, not a teammate. Revision 2's retraction of
the CL 3564 guess (V11) was correct.

Incidentally this validates Task 4's cost model: ~20 pending changelists means ~20 `describe` calls,
so the N+1 concern is real but bounded — bounded concurrency plus a cap is sufficient.

### V23 — Blast radius re-checked across EVERY workspace, including local overrides `VERIFIED`

Revision 2's V9 measured only OperationPhoenix, OnSight and BreakOut2025. Five `.mcp.json` files
exist under `D:/UnrealProjects`; the other two were never opened, and `.mcp.local.json` overrides —
where an extra registration would most plausibly hide — were never enumerated at all. Since V9 is the
sole basis for the claim that the approved breaking change is cheap, this was a real gap.

| Workspace | file | bridge servers wired |
|---|---|---|
| `5.3/hijack_prototype` | `.mcp.json` | uemcp only |
| `5.6/KatanaCombat` | `.mcp.json` | uemcp only |
| `5.6/MotionMatching_Demo` | `.mcp.json` | uemcp only |
| `5.6/OnSight` | `.mcp.json` | uemcp, **perforce** |
| `5.6/OperationPhoenix` | `.mcp.json` | uemcp, **atlassian, perforce, miro** |
| `5.6/OperationPhoenix` | `.mcp.local.json` | **none** (credential overrides only) |
| `5.6/BreakOut2025` | — | no `.mcp.json` |

**V9's table is complete.** No additional workspace consumes `atlassian` or `miro`.

A consumer sweep with **no file-type filter** (Revision 2's used `--include=*.md,*.json,*.mjs,*.js`,
missing `.py`/`.ps1`/`.yaml`/agent+hook definitions) across all three consuming workspaces found
exactly one hit: `OperationPhoenix/.claude/skills/knowledge-drift-audit/SKILL.md`, which uses
`miro_get_connectors` — already counted in V9. **No previously-unknown consumers exist.**

### V24 — Task 8's design assumption holds `VERIFIED`

Task 8 proposes accepting any space `type` string. That required v1's `type` **query parameter** to
accept `collaboration`, which had only been observed in a *response body* (V13), not as an input:

```
GET /wiki/rest/api/space?type=collaboration&limit=100  ->  size: 1, key: "PO"
```

It is a valid query value. "Accept any type string and document the real set" is implementable; the
fallback (drop the filter and filter client-side) is not needed.

### V22 — Deferred item 8's connector claim does not reproduce on the board tested `VERIFIED`

`Tasking and Review Workflow` (`uXjVH8yMcYE=`): **8 connectors, all 8 carrying both `startItem` and
`endItem`.** The audit's "8 of 29 connectors with no endpoints" was on an unidentified board.

Deferred item 8 must **identify its board first**; its premise is unconfirmed. (Its other half — that
endpoints carry ids but no content — is structural and independently true.)

### V11 — The audit's "55-file shelf" was not located `VERIFIED (negative)`

CL 3564 (`jshaun@OA_Hook_DT`, "OA-909 safety shelf") carries **9** shelved files, not 55. Revision 1
of this plan speculated that 3564 was the audit's unregistered shelf; that speculation is
**retracted**. The 55-file shelf may be a different changelist or a different client. This does not
affect Tasks 4 or 5, whose capability is verified independently (V7).

### V12 — The `jira_search` migration list inherited from the 2026-05-06 handoff is stale `VERIFIED`

The handoff names five Operation-Phoenix skills carrying the `jira_request` 410 workaround.
All five files exist. **None contains the workaround.**

| Skill | `search/jql` refs | `jira_search` refs | 410 notes |
|---|---|---|---|
| `jira-status/SKILL.md` | 0 | 4 | 0 |
| `jira-sync/skill.md` | 0 | 3 | 0 |
| `triage-jira/SKILL.md` | 0 | 3 | 0 |
| `triage/SKILL.md` | 0 | 3 | 0 |
| `fill-invoice/SKILL.md` | 0 | 1 | 0 |

They already call `jira_search` directly. **Task 2's skill-revert step is deleted — it is work that
does not need doing.** The memory file
`.../D--UnrealProjects-5-6-OperationPhoenix/memory/reference_jira_search_410_workaround.md` **does**
still exist and should be retired.

### V13 — NEW BUG: `confluence_list_spaces` hides the primary project space `VERIFIED`

Not in the audit. Higher impact than item 6.

```
GET /wiki/rest/api/space?limit=100  ->  size: 25, no _links.next   (25 is the true total)
space types present: collaboration: 1, global: 1, personal: 23

/wiki/rest/api/space/PO -> key "PO", name "Project OnSight", type "collaboration", status "current"
PO holds 161 pages — the largest space on the instance.
```

The tool describes its filter as `"Filter: 'global' or 'personal'"`. **`PO` is neither.** Filtering
by `global` returns only `MFS`, which holds **0** pages. A caller asking "does a page about X exist
in this space?" while filtering gets a confident, complete-looking, wrong answer.

This is item 1's failure mode (omission indistinguishable from absence) on a different surface.

### V14 — NEW BUG: `confluence_list_spaces` has no `limit` parameter `VERIFIED`

Tool schema is `{ type }` only; the handler hardcodes `confluence.listSpaces(50, type)`. A caller
passing `limit: 100` has it silently discarded by zod. There is no `start`, no `total`, no `isLast`.
It does not truncate today only because the instance has 25 spaces — it will silently truncate at 50.

### V15 — NEW GAP: no rate-limit handling anywhere in the HTTP bridges `VERIFIED`

```
$ grep -rn "429|rate.limit|retry" atlassian/server.mjs miro/server.mjs
(no matches)
```

Task 1 fans out one `GET /issue/{key}` per key — the audit's real batch was **181 keys**. With no 429
handling, a rate-limited response becomes a generic thrown error and, in a naive implementation, an
`error` verdict. That would recreate the exact ambiguity this work exists to remove: a key whose
status is unknown, reported as if it were checked.

### V16 — Scale of the Jira index anomaly, measured `VERIFIED`

Sampled the contiguous range `OA-820`..`OA-845` (26 keys), comparing JQL visibility against `GET`:

| | count | keys |
|---|---|---|
| visible to JQL | 20 | 820–828, 830, 831, 833–838, 840–842 |
| genuinely deleted (GET 404) | 5 | 832, 839, 843, 844, 845 |
| **alive but invisible to JQL** | **1** | **829** |

So roughly **1 in 21 live issues** in this sample is missing from the search index. Not systemic, but
not a one-off either, and the affected ticket is Highest priority. Two consequences:

1. `jira_validate_keys` is **not** merely a band-aid — per-key GET is the only correct route for
   reference integrity, independent of the index defect.
2. The index defect is real and **no bridge change fixes it**. It needs a Jira admin (reindex).
   Every JQL-based tool in the bridge silently under-reports until then.

---

## Review Corrections (Revision 1 -> 2)

What changed after checking Revision 1's claims against evidence:

| # | Revision 1 said | Evidence | Now |
|---|---|---|---|
| 1 | Table is on `Long Term Sever Plan` (from audit) | V10 | Corrected to `Milestone 2 Plan`; defect confirmed |
| 2 | Revert 5 skills off the `jira_search` workaround (from handoff) | V12 | **Deleted** — already migrated |
| 3 | CL 3564 is "likely the audit's 55-file shelf" | V11 | **Retracted** — 9 files, not 55 |
| 4 | Only `confluence_space_pages` has the truncation disease | V13, V14 | `confluence_list_spaces` is worse; new Task 8 |
| 5 | Envelope applied per-tool | — | Hand-rolling repeats the drift; new Task 9 (shared `lib/` helper) |
| 6 | `client.mjs` extraction is routine | V3 | `atlassian` has **zero** tests — no safety net for 35 tools; see Risks |
| 7 | Fan-out needs bounded concurrency | V15 | Also needs 429 handling and a `rate_limited` verdict |
| 8 | `p4_shelves` returns a `scope` field | V7, perforce `scope` convention | `p4_changes(allUsers)` must carry it too |

### Revision 2 -> 3

| # | Revision 2 said | Evidence | Now |
|---|---|---|---|
| 9 | Audit misattributed the Miro board | V10 (retracted) | **Audit was right.** Revision 2's own probe truncated at 2500 chars and manufactured the error. |
| 10 | Only `table`/`table_text` affected | V17 | `widgets_stack` too — three types; fix must be generic |
| 11 | Item 3(b) unknown | V17 | Still open, but evidence strongly negative (`isSupported: false`, no `data`) |
| 12 | Item 6 acceptance undemonstrable | V19 | Demonstrated end-to-end on `PO` (100 + 61, `next` flips) |
| 13 | `moved` needs testing | V20 | Unreachable — one project on the instance |
| 14 | Miro has no completeness signal | V18 | Miro supplies a real `total` **and** cursor; `miro_get_connectors` supplies neither |
| 15 | 55-file shelf unlocated | V21 | CL 3553, owned by `noah` |
| 16 | Deferred item 8 premise assumed | V22 | Did not reproduce on the board tested; board unidentified |

---

## Design Decisions

Settled with the requester before implementation:

1. **Scope**: items 1–6 this pass, then checkpoint before items 7–11.
2. **Structure**: extract `client.mjs` + `client.test.mjs` for `atlassian` and `miro`, matching the
   existing `perforce`/`otter` precedent. New logic must be unit-testable against a mocked `fetch`.
3. **Response shape**: clean envelope (`{total, isLast, items}`) on list endpoints, accepting
   breakage, **paired with** a downstream migration handoff instructing Operation-Phoenix agents to
   update every affected skill. Per V9 the realised breakage is near zero, but the handoff is still
   written and lists verified call sites only.

### Cross-cutting principle

> A list response that happens to equal its limit is indistinguishable from a complete one.

Every list-style response gains an explicit `isLast`. `total` is included **only where the upstream
API actually supplies it** — never inferred from a page count, since a fabricated total recreates the
exact "looks complete, isn't" failure this work exists to remove. Where no total is available the
response says so rather than omitting the field silently.

---

## Task 1 — `jira_validate_keys` (audit item 1, P0)

**Files**: `bridges/atlassian/client.mjs` (new), `client.test.mjs` (new), `server.mjs` (tool wiring)

### 1a. Attach HTTP status to errors — prerequisite

`AtlassianClient.request()` (`server.mjs:104-107`) currently throws:

```js
throw new Error(`Atlassian API ${resp.status}: ${text}`);
```

The status is stringified into the message and lost structurally. Attach it before throwing:

```js
const err = new Error(`Atlassian API ${resp.status}: ${text}`);
err.status = resp.status;
err.body = text;
throw err;
```

Message text is unchanged, so nothing downstream that matches on the string breaks. Every other tool
benefits.

### 1b. The tool

```
jira_validate_keys(keys: string[], checkSearchable?: boolean) -> {
  total: number,
  isLast: true,
  summary: { exists, not_found_or_no_permission, moved, exists_not_searchable, error },
  results: [ { key, verdict, resolvedKey?, note? } ]
}
```

Server-side fan-out of `GET /rest/api/3/issue/{key}?fields=key` per key, bounded concurrency
(start at 5).

**429 handling is mandatory, not optional (V15).** There is currently no retry or rate-limit logic
anywhere in the HTTP bridges, and the audit's real batch was 181 keys. Requirements:

- On 429, honour `Retry-After` and retry with exponential backoff, bounded (3 attempts).
- If a key still cannot be resolved after retries, its verdict is `rate_limited` — **never** `error`
  and never silently omitted. A key whose status is unknown must say so.
- The response carries a top-level `unresolved` count so a caller can tell a complete batch from a
  partially rate-limited one.

This is the cross-cutting principle applied to a bulk lookup: naming what could not be resolved is
the whole point of the tool.

**Verdict vocabulary** — revised from the audit's request per V5 and V6:

| Verdict | Condition | Notes |
|---|---|---|
| `exists` | GET 200 | |
| `not_found_or_no_permission` | GET 404 | **Renamed.** Jira conflates these (V6); a `no_permission` verdict would be a fabrication. |
| `no_permission` | GET 403 | Emitted only if Jira genuinely returns 403. Retained because it costs nothing. |
| `moved` | GET 200 **and** `response.key !== requestedKey` | **Unreachable here (V20)** — one project on the instance, so no cross-project moves. Keep as a defensive two-line check; document as unexercised. |
| `exists_not_searchable` | GET 200 **and** a follow-up `key = X` JQL probe returns empty | **New.** This is the OA-829 class (V5) — the actual bug. Gated behind `checkSearchable` since it doubles the call count. |
| `rate_limited` | 429 after bounded retries | **New, per V15.** Status unknown — must not read as absent. |
| `error` | any other failure | Carries the status. Never silently folded into "missing". |

**`checkSearchable` default — decision required.** The OA-829 class (V5) is the failure that
motivated this entire work item, yet gating its detection behind an opt-in flag means the default
call does not detect it. Options: default it ON (2x calls, catches the real bug by default), or
default OFF and have the tool's description state plainly that `exists` does not imply
JQL-visible. Recommendation: **default ON**, since correctness was the stated P0 and the caller
asking to validate keys is by definition doing reference integrity.

**Non-goal**: the audit's fallback option (b) — diffing requested vs returned keys inside
`jira_request` for any `key in (...)` query — is explicitly **not** built. It requires sniffing
arbitrary JQL (case variants, quoting, mixed clauses), and per V5 it would misreport `OA-829`.

### Tests (`client.test.mjs`, mocked `fetch`)

- mixed batch of 200 / 404 / 403 returns one verdict per key, no key dropped
- a 404 yields `not_found_or_no_permission`, never `not_found` alone
- `results.length === keys.length` for every input, including duplicates and empty input
- a 500 on one key yields `error` for that key and does not abort the batch
- `checkSearchable: true` on a GET-200/JQL-empty key yields `exists_not_searchable`
- concurrency cap is respected (no more than N in flight)

### Acceptance

A batch of live, deleted, and restricted keys returns a per-key verdict, and no caller can mistake
omission for deletion — because omission is impossible: `results` is always the same length as `keys`.

---

## Task 2 — Retire the `jira_search` 410 folklore (audit item 2, P0)

**No bridge code change.** Per V4 the tool works.

1. Update `_handoffs/2026-05-06-jira-wiring-fix.md`: mark **NOT REPRODUCIBLE as of 2026-08-17**,
   record the three verified query shapes, and state that the POST patch it proposes must **not** be
   applied blind.
2. ~~Revert five Operation-Phoenix skills off the workaround.~~ **DELETED per V12** — all five
   already call `jira_search` directly and carry no 410 notes. The handoff's migration list described
   work that was either already done or never needed. No downstream skill change is required.

3. Flag for deletion: memory
   `C:/Users/posne/.claude/projects/D--UnrealProjects-5-6-OperationPhoenix/memory/reference_jira_search_410_workaround.md`
   (confirmed still present).

**Lesson to record in the handoff**: the 410 claim survived three months and propagated into a repo
handoff and a memory entry because the diagnosis was written from the consumer side and never
executed against the bridge. Revision 1 of *this* plan then inherited its migration list without
checking. Any future bridge handoff must state which claims were executed and which were reasoned.

### Acceptance

`jira_search` either works or is absent from the tool list. It works — so the acceptance is that no
consumer still carries a comment claiming otherwise.

---

## Task 3 — `miro_request` passthrough (audit item 3, P1)

**Files**: `bridges/miro/client.mjs` (new), `client.test.mjs` (new), `server.mjs`

Mirror `jira_request`'s signature exactly:

```
miro_request(path: string, method?: "GET"|"POST"|"PATCH"|"PUT"|"DELETE",
             queryParams?: object, bodyJson?: object)
```

Note from V8's sibling finding: `confluence_request` rejects numeric `queryParams` values
(`z.record(z.string())`). `miro_request` should coerce numbers to strings rather than erroring, so
`{limit: 50}` works as callers expect.

Must handle **three** unsupported types, not just tables (V17): `table`, `table_text`,
`widgets_stack`. Nothing in the implementation may be table-specific.

### Acceptance, split honestly

- **(a) achievable**: the passthrough reaches an arbitrary Miro API path. Will be tested.
- **(b) `OPEN`, and the evidence is strongly negative.** "The timeline table's cell text is
  retrievable by some route." Per V17, Miro returns `isSupported: false` with **no `data` field** for
  these types — the API declares them unserialized rather than merely omitting content. Direct probes
  of `/v2/.../items/{id}` and `/v2-experimental/.../tables` could not be completed from the
  verification harness (sandbox network filtering — the bridge process reaches paths the throwaway
  script cannot), so a documented-endpoint search remains outstanding.

  **Expected outcome: not achievable.** The passthrough should still be built — it unblocks the other
  two unsupported types, any future one, and every endpoint the 17 purpose-built tools don't model.
  But (b) must be reported as **not achievable** if the evidence holds, not quietly dropped, and the
  first use of `miro_request` should be to settle it.

### Tests

- builds the correct URL with query params, including numeric coercion
- passes a JSON body on POST/PATCH and omits it on GET
- surfaces non-2xx status structurally (same `err.status` treatment as Task 1a)

---

## Task 4 — Perforce shelved files (audit item 4, P1)

**Files**: `bridges/perforce/parsers.mjs`, `parsers.test.mjs`, `server.mjs`, `server.test.mjs`

Two additions, both purely additive (V9: no shape change to the 23 consuming skills):

1. `shelved: boolean` on `p4_describe` -> appends `-S`.
2. `p4_shelves(client?, allUsers?)` — the shape the workflow actually wants: one call returning every
   pending changelist with owner, client, description, and its shelved file list.

`p4_shelves` composes `p4 changes -s pending` (Task 5's argument builder) with `p4 describe -S -s`
per changelist. Parsing lives in `parsers.mjs` as a pure function over `p4` text so it is testable
without a server: shelved-file lines are `^\.\.\. ` prefixed (V7).

Return shape gains the envelope: `{total, isLast, scope, changelists: [...]}` where `scope` records
whether the result is user-filtered or all-users, following the existing scope-leak convention in
`jira_list_boards` and the admin tier.

**N+1 cost — must be bounded.** `p4_shelves` issues one `p4 describe -S -s` per pending changelist,
each with the bridge's 60s timeout. The audit looped over 16 changelists; an all-users sweep on a
busy server could be far larger. Requirements:

- Bounded concurrency over the describe calls (start at 4).
- A `maxChangelists` cap with a sane default.
- **If the cap truncates the result, say so** (`isLast: false` plus an explicit `truncated` note).
  A silent cap here would reproduce the audit's own cross-cutting complaint inside its own fix.

**Known debt (accepted, not solved here)**: `p4_shelves` returns structured JSON while `p4_changes`
and `p4_describe` return raw `p4` text, so the Perforce bridge will carry two response paradigms.
The structural fix is parsing all `p4` output through `parsers.mjs`, which already exists for exactly
this purpose. That is a larger migration touching 23 consuming skills and is deliberately out of
scope — recorded so it is a choice, not an oversight.

### Tests

- `buildDescribeArgs({shelved: true})` emits `-S`
- shelved-file parser extracts path + revision + action from real `p4 describe -S -s` output
  (fixture captured from CL 3564, V7)
- a changelist with no shelved files yields an empty list, not a parse error
- `p4_shelves` reports `scope: "all-users"` vs `scope: "user:noah"` correctly

### Acceptance

One call returns all pending changelists with shelved file counts and paths, across all clients.

---

## Task 5 — `p4_changes` across all users (audit item 5, P1)

**Files**: `bridges/perforce/parsers.mjs`, `parsers.test.mjs`, `server.mjs`

`buildChangesArgs` currently applies `-u <defaultUser>` when neither `user` nor `client` is given.
Add an explicit `allUsers: boolean` that suppresses the default-user filter:

```js
export function buildChangesArgs({ status, max, user, client, allUsers, defaultUser, depotRoot }) {
  // when allUsers is true: never push -u, even with no user/client
}
```

Prefer the explicit boolean over the audit's alternative (`user: "*"`), because `"*"` is a value that
could plausibly reach `p4` as a literal username and is harder to validate.

`allUsers` and `user` together is a contradiction — reject it with a clear error rather than silently
letting one win.

**Must follow the bridge's own scope-leak convention.** `perforce/server.mjs` already wraps unscoped,
server-global results with `scope: "server-global"` and a `warning` field (see the admin tier, and
`jira_list_boards` in the Atlassian bridge). `allUsers: true` returns other teams' pending work and
is exactly that case, so it must carry the same `scope` + `warning` wrapper. Revision 1 applied this
to `p4_shelves` only — that was an inconsistency, not a design.

### Tests (extend `parsers.test.mjs`)

- `allUsers: true` with no user/client omits `-u` entirely
- `allUsers: true` still appends `-m <max> <depotRoot>` (V7: scoping does not re-apply a user filter)
- `allUsers: true` + `user: "noah"` throws
- existing default-user behavior is unchanged when `allUsers` is absent — **regression guard for the
  23 consuming skills**

### Acceptance

A single call returns pending changelists for every user the ticket can see.

---

## Task 6 — `confluence_space_pages` pagination (audit item 6, P1)

**Files**: `bridges/atlassian/client.mjs`, `client.test.mjs`, `server.mjs`

```
confluence_space_pages(spaceKey, limit?, start?) -> {
  start, limit, count, isLast, total: null, pages: [...]
}
```

- `start` threads through to the v1 `start` query parameter (V8: supported).
- `isLast` is derived from the **absence of `_links.next`** — the only reliable signal.
- `total` is `null` with an explicit note that the v1 endpoint does not supply one. It is **not**
  inferred from `size`, which is a page count.

This is a breaking shape change (bare array -> envelope) with **zero verified consumers** (V9).

Deferred alternative: migrating to v2 `/wiki/api/v2/spaces/{id}/pages` (cursor-based, V8) would be
cleaner but still yields no total, and costs a space-key-to-id lookup. Not worth it for this pass.

### Tests

- `_links.next` present -> `isLast: false`; absent -> `isLast: true`
- a full page (`count === limit`) with no `next` link still reports `isLast: true` — **the exact
  ambiguity this item exists to kill**
- `start` is forwarded to the request
- `total` is `null`, never a fabricated number

### Acceptance

A space with more than 100 pages can be enumerated to completion, and the response says whether it is
the last page.

---

## Task 8 — `confluence_list_spaces`: the same disease, worse (NEW, from V13/V14)

**Files**: `bridges/atlassian/client.mjs`, `client.test.mjs`, `server.mjs`

Not in the original audit. Added because fixing `confluence_space_pages` alone would leave the
sibling endpoint silently hiding the instance's primary 161-page space — a symptom fix.

Three changes:

1. **Expose `limit` and `start`.** The tool currently accepts neither (V14); `limit` is hardcoded to
   50 and a caller-supplied `limit` is silently discarded by zod.
2. **Fix the type filter.** The description claims `'global' or 'personal'`. Real types on this
   instance are `collaboration`, `global`, `personal` (V13). Either accept any type string and
   document the real set, or drop the filter to a pass-through. **Do not** keep a two-value
   description that hides a space type.
3. **Envelope**: `{total, start, limit, count, isLast, spaces}`, `isLast` from `_links.next`.

### Tests

- a `collaboration`-type space appears in unfiltered results
- `type: "global"` does not silently swallow other types — behavior is documented and asserted
- caller-supplied `limit` reaches the request rather than being discarded
- `count === limit` with no `next` link still reports `isLast: true`

### Acceptance

Enumerating spaces cannot omit a space type the caller did not know to ask for, and the response says
whether it is complete. Verifiable today: `PO` / "Project OnSight" must appear.

---

## Task 9 — Shared list-envelope helper in `lib/` (NEW, structural)

**Files**: `MCP-Servers/lib/tool-result.mjs` (extend), `lib/tool-result.test.mjs`

Revision 1 hand-rolled the `{total, isLast, ...}` envelope separately in Tasks 4, 6 and 8. That is how
the drift being fixed happened in the first place: `jira_search` grew `isLast`, `confluence_search`
grew `total`, `confluence_space_pages` grew neither, and nothing held them to a shape.

The repo already centralises response shape in `lib/tool-result.mjs` (`toolJsonResult`,
`toolTextResult`, `toolErrorResult`) precisely so "bridges don't drift on formatting over time" — its
own header comment. The list envelope belongs there:

```js
toolListResult(items, { total = null, isLast, start, limit, scope, warning, truncated })
```

Rules it enforces so callers cannot get them wrong:

- `isLast` is **required** — a list result cannot be produced without stating completeness.
- `total: null` is explicit and legal; a fabricated total is not derivable from a page count.
- `truncated` is surfaced whenever a server-side cap was applied.

Tasks 4, 6 and 8 then consume this helper rather than each inventing a shape. This is the item that
makes the audit's cross-cutting principle durable instead of a one-pass cleanup; without it, items
7–11 will each re-invent an envelope.

---

## Task 7 — Downstream migration handoff

**File**: `_handoffs/2026-08-17-bridge-audit-remediation-downstream.md`

Written for the Operation-Phoenix agents. Contents:

- The five skills to revert off the `jira_search` workaround (Task 2), with the note that the 410 was
  never real.
- The memory entry to delete.
- `confluence_space_pages` now returns an envelope — **zero known consumers**, listed so a future
  consumer isn't surprised.
- New capabilities available: `jira_validate_keys`, `miro_request`, `p4_shelves`,
  `p4_changes(allUsers)`, `p4_describe(shelved)`.
- Explicit statement that any reference-integrity check over Jira keys must use `jira_validate_keys`
  and **must not** infer deletion from absence in a `key in (...)` result (V5).

---

## Deferred — audit items 7–11

Recorded so they are not lost. Not in this pass.

| # | Item | Note |
|---|---|---|
| 7 | Large Confluence bodies need server-side `format: "text"` / `section` selector | 400KB pages currently need client-side Python to read |
| 8 | `miro_get_connectors` endpoint content + reason for missing endpoints | 8 of 29 connectors returned no endpoints at all; cause unknown |
| 9 | `miro_get_board_items` 50-item cap / multi-type filter / `get_all_items` | 264-item board needs hand-managed cursors |
| 10 | `jira_get_links(issueKeys[])` with `targetExists` | dangling-link detection is currently many calls |
| 11 | Confluence version diff / `confluence_get_page(pageId, version)` | causation currently unprovable |

### Explicitly out of scope — not a bridge problem

The audit's Otter findings (summary/action-item quality, garbled ticket numbers, `include_transcript`
batching) are **not actionable in this repo**. Otter is consumed via the provider-hosted MCP
(`mcp__claude_ai_Otter_ai__*`), not `bridges/otter/`, which is vestigial. These are upstream feature
requests to Otter. Do not re-open them here.

---

## Open Questions

All blocking unknowns were closed before lock-in. What remains is listed with its status.

1. ~~`moved` verdict~~ **RESOLVED (V20)** — one project on the instance, so moves are unreachable.
   Implemented defensively, documented as unexercised. Same for `no_permission` / 403 (V6, V20).
2. ~~Item 6 acceptance is undemonstrable.~~ **RESOLVED (V13).** Space `PO` ("Project OnSight") holds
   **161 pages** — above the 100 limit — so end-to-end enumeration is directly demonstrable. `MFS`
   was a red herring: it is the only `global` space and holds 0 pages, which is why Revision 1
   could not find content. Acceptance test: enumerate `PO` to completion across two pages and assert
   `isLast` flips only on the final one.
3. **Item 3(b) acceptance (Task 3)** — the ONLY remaining unknown that gates an acceptance criterion,
   and it cannot be closed before the passthrough exists (settling it is the passthrough's first use).
   Evidence is strongly negative: `isSupported: false`, no `data` field (V17). Expected outcome: not
   achievable. Not a blocker for starting — Task 3(a) is well-defined regardless.
4. **Why is OA-829 unindexed (V5, V16)?** Out of scope for the bridge fix, but it is a live
   Highest-priority ticket invisible to every JQL query — about 1 in 21 live issues sampled. A real
   problem for the team independent of tooling. Worth raising with a Jira admin; a project reindex is
   the usual remedy. **Until then every JQL-based tool in this bridge under-reports.**
5. **Deferred item 8 board unidentified (V22)** — its "8 of 29 connectors without endpoints" claim did
   not reproduce on the board tested (8 of 8 had both). Identify the board before working that item.
6. **Rate limits (V15)** — Jira Cloud's actual per-account thresholds were deliberately not probed
   (hammering a live production instance to find a limit is not a reasonable test). The 429 handling
   in Task 1 is written defensively against documented behavior, not measured behavior.

---

## Self-Review

- **Placeholders**: none. Every task names concrete files and concrete assertions.
- **Consistency**: the envelope principle (Design Decisions) is applied in Tasks 4 and 6 and
  explicitly *not* applied to the raw-text Perforce tools, with V9 as the justification.
- **Scope**: six tasks plus a handoff. Tasks 4 and 5 share `parsers.mjs` and should be done together.
- **Ambiguity**: the audit's four-way verdict for item 1 was ambiguous once V6 landed; resolved by
  renaming to `not_found_or_no_permission` and documenting why.
- **Biggest risk**: Tasks 4 and 5 touch `buildChangesArgs`, which 23 skills depend on transitively.
  The regression guard in Task 5's test list is the mitigation.

### Risk: the `client.mjs` extraction has no safety net

Revision 1 treated "extract `client.mjs`" as routine. It is not. `AtlassianClient` backs **35 tools**
consumed by **7 Operation-Phoenix skills**, and the bridge has **zero existing tests** (V3) — so the
refactor would be performed with nothing to catch a regression, on a server those workspaces load by
path with no version pin (V2).

Required sequencing, not optional:

1. Extract **mechanically** — a pure move of the class, no logic changes, no signature changes, in
   its own commit.
2. Smoke-test every affected tool over stdio before any behavioral change lands on top. A probe
   harness for this already exists from the verification work
   (`scratchpad/probe.mjs` — spawns the server, calls one tool, prints the result).
3. Only then layer Tasks 1, 6 and 8 on the extracted client.

If sequencing 1–3 cannot be done in one sitting, prefer **no extraction** over a half-extracted
client — two sources of truth for 35 tools is worse than a monolith with tests around the new logic.

### Structural items deliberately NOT solved here

Recorded so each is a decision rather than an omission:

| Item | Why deferred |
|---|---|
| Jira search index missing live issues (V16) | No bridge change fixes it; needs a Jira admin reindex. `jira_validate_keys` routes around it correctly, but every JQL tool under-reports until it is fixed. |
| Perforce dual response paradigm (Task 4) | Parsing all `p4` output through `parsers.mjs` touches 23 skills. |
| No typed error model across bridges | Task 1a attaches `err.status` where needed; a general error taxonomy is a larger change. |
| `jira_search` does not expose `fields` | The client method supports it; the tool schema omits it, so callers cannot narrow payloads. One-line gap, relevant to deferred item 7. |
