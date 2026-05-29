# Handoff: Perforce bridge — admin/identity tool tier

**Date**: 2026-05-29
**Bridge/Scope**: `MCP-Servers/bridges/perforce/` (server.mjs, parsers.mjs, README.md)
**Status**: Phase 1 implemented (2026-05-29) / Phase 2 partial: `p4_group_set`
implemented (2026-05-29), `p4_protect_set` deferred (see below)
**Severity**: Low — additive feature work, no existing behavior changes. The
risk to manage is *information disclosure* (server-global reads) and, in the
deferred Phase 2, *global state mutation*.

---

## Why this exists

A user request ("put `keem` in a group with `Timeout: unlimited` so his login
ticket stops expiring every 24h") exposed that the Perforce bridge has **no
administrative / identity / session surface at all**. The 31 existing tools are
entirely workspace-file/changelist workflow (`info, opened, changes, describe,
diff, filelog, print, annotate, fstat, where, have, create/update/delete_changelist,
reopen, add, move, sync, resolve, edit, reconcile, delete, revert, lock, unlock,
submit, shelve, unshelve, integrate, copy, merge`).

To even *answer* whether a user can self-serve a group change, you have to
reason about Perforce's protection model — the server can't introspect it.
This tier adds that introspection.

## Decisions already made (don't relitigate)

- **Phase 1 = read-only tools only.** Writers (`p4_group_set`, `p4_protect_set`)
  are explicitly deferred to a separate change.
- **Writer gating (manifest opt-in flag vs always-registered) = decide at Phase 2.**
  Not in scope for Phase 1.
- Build target for Phase 1: the five read tools + parsers + unit tests + README.

## Design constraints inherited from the existing bridge

1. **`p4()` always injects `-c P4CLIENT`** (`server.mjs:48,83`). `p4 users`,
   `p4 groups`, `p4 group -o`, `p4 login -s`, and `p4 protects` all ignore the
   client arg, so **no runner change is needed** — but it confirms these tools
   bolt onto a workspace-scoped harness and are themselves server-global.
2. **Scope-leak convention** (`_handoffs/2026-05-18-bridge-scope-leak-audit.md`):
   any tool whose output crosses a resource boundary must wrap its response with
   a `scope` field (and a `warning` field when the read is unscoped/broad). Every
   tool in this tier reports on the **whole server**, not `//P4DEPOT/...`, so each
   carries `scope: "server-global"`. This is the audit convention applied, not a
   new pattern.
3. **Logic lives in `parsers.mjs`** (pure, side-effect-free, dependency-free so it
   unit-tests without launching the stdio server — see the file header).
   `parsers.test.mjs` holds the real coverage (98 tests today). `server.test.mjs`
   is a registration smoke test only — extend its name-assertion block by one line
   per tool.
4. **Result helpers**: use `toolTextResult` / `toolErrorResult` from
   `../../lib/tool-result.mjs`; for structured (scope-wrapped) output use
   `toolJsonResult`. Don't hand-roll the content-block shape (except `p4_info`'s
   pre-existing bespoke block).

## Phase 1 — read-only diagnostic tools

All five are pure reads. No `preview` param (they don't mutate). Each wraps output
with `scope: "server-global"` per constraint #2.

| Tool | p4 command | Purpose | Schema |
|---|---|---|---|
| `p4_users` | `p4 users [user...]` | Resolve a display name/handle to the real login (e.g. screenshot said `keem.`, real login is likely `keem`). | optional `user` (string or string[]); omitted = all users → include `warning` |
| `p4_groups` | `p4 groups [user]` | List a user's group memberships, or all groups. Answers "is this user already in a no-timeout group?" | optional `user`; omitted = all groups |
| `p4_group_info` | `p4 group -o <name>` | Read a group spec including the `Timeout` field. Read-only `-o` form; distinct from the deferred writer. | required `group` (string) |
| `p4_login_status` | `p4 login -s` | The actual *symptom* tool: is the ticket valid, and when does it expire? Diagnoses the "24h cooldown". | optional `user` |
| `p4_protects` | `p4 protects [-m] [-u user]` | Capability probe. `-m` returns the effective max access level (list/read/open/write/admin/super). Answers "can this user do X themselves?" | optional `max` (bool → `-m`), optional `user` (super-only when targeting others) |

### Parsers to add (`parsers.mjs`) + tests (`parsers.test.mjs`)

Match the existing pure-function style (fixture string in → structured out):

- `parseUsersOutput(text)` → `[{ user, email, fullName, lastAccess }]`.
  `p4 users` line format: `user <email> (Full Name) accessed YYYY/MM/DD`.
- `parseGroupsOutput(text)` → `string[]` (one group name per line).
- `parseGroupSpec(text)` → `{ group, timeout, maxResults, maxScanRows, maxLockTime, users:[], owners:[], subgroups:[] }`.
  Reuse the tab-indented-block parsing pattern already proven in
  `parseChangeSpecDescription` (`parsers.mjs:18`) — same section-header/indent rules.
- `parseLoginStatus(text)` → `{ user, expiresInSeconds | "unlimited" | "expired", raw }`.
  `p4 login -s` prints either `User <u> ticket expires in NNN hours MM minutes.`,
  `...ticket expires in NNN seconds.`, or an error (`Perforce password (P4PASSWD)
  invalid or unset.` / `Your session has expired`). Parse both the valid and
  expired/no-ticket cases — the expired case is the one the user is hitting.
- `parseProtectsMax(text)` → one of the access-level strings. `p4 protects -m`
  prints a single bare level token.

Keep all regexes fixed-literal (no caller-supplied dynamic construction) — the
`CL_LINE_RE` comment at `parsers.mjs:43` documents the ReDoS-avoidance rule the
repo follows.

### server.mjs registration

- Register the five `server.tool(...)` blocks alongside the existing reads
  (after `p4_have`, ~line 308, is a natural home — keep reads grouped).
- Each handler shells via the existing `p4()` runner and wraps with
  `toolJsonResult({ scope: "server-global", warning?, ...parsed })`.
- No new env/config/manifest fields in Phase 1 (those are a Phase 2 gating
  question).

### Tests

- `parsers.test.mjs`: a `describe` block per new parser, fixtures for the normal
  case **and** the edge case that bites (expired ticket, multi-group user,
  empty group list, user with no `Owners`).
- `server.test.mjs`: extend the `toolNames.includes(...)` assertion block
  (currently ~line 45–60) with the five new names.

## Verification steps

1. From `MCP-Servers/bridges/perforce/`: `npm test` — new parser tests green,
   existing 98 + registration smoke still green.
2. `node --check server.mjs` — syntax clean.
3. Live (requires a real P4 connection with a valid ticket):
   - `p4_users` with no arg → all users wrapped with `scope` + `warning`.
   - `p4_groups({ user: "<you>" })` → your memberships.
   - `p4_login_status()` → ticket expiry; force-expire a ticket (`p4 logout`)
     and confirm the parser reports the expired case rather than throwing.
   - `p4_protects({ max: true })` → your effective level (sanity-check it
     matches what you expect for your account).

## End-to-end payoff (the original request, fully answered by Phase 1 reads)

1. `p4_users` → confirm `keem`'s real login.
2. `p4_groups({ user: "keem" })` → is he already in a no-timeout group?
3. `p4_login_status({ user: "keem" })` → confirm the symptom is ticket expiry.
4. `p4_protects({ max: true })` → confirm *you* are `super` (and that keem is
   not, which is why he can't self-serve).

The actual group write (`Timeout: unlimited`) is Phase 2 (`p4_group_set` via
`p4 group -i`), which will also add the **capability pre-check** primitive:
shell `p4 protects -m` before mutating, fail fast with a structured
"requires super; your level is <x>" error instead of a raw p4 permission error.

## Notes

- Branch for this work: `claude/perforce-admin-tools` (cut from `main`-equivalent
  HEAD `47247e4`; pushed, tracking).
- Security framing for Phase 2 (carry forward): `Timeout: unlimited` means a
  leaked ticket never auto-expires. A long-but-finite value (e.g. `1209600` =
  2 weeks) removes the daily re-login pain without the open-ended risk. Surface
  this to the operator at the writer stage; don't silently grant unlimited.
- `MaxResults`/`MaxScanRows`/`MaxLockTime` on a group spec default to `unset` —
  the group parser must distinguish `unset` (blank, no limit imposed) from a
  numeric value, so a future writer doesn't accidentally impose query limits.

## Phase 2 — implemented (2026-05-29)

**Gating decision made: opt-in manifest flag.** New manifest field
`P4_ENABLE_ADMIN` (default `"false"`). Admin WRITE tools register only when it
resolves to `"true"`. Default install stays workspace-scoped. Verified by two
spawn tests in `server.test.mjs` (absent by default; present with the flag).

**`p4_group_set` — done.** `server.mjs`, gated by `ADMIN_WRITES_ENABLED`.
- Capability pre-check: `requireSuper()` runs `p4 protects -m` and returns a
  structured refusal (`insufficient` / `protects-failed`) before any mutation.
- Read-modify-write: reads `p4 group -o <name>` (template for new groups),
  applies only requested fields via `applyGroupSpecChanges` (parsers.mjs),
  preserves Max* and all other fields, writes via `p4 group -i`.
- `preview: true` default → returns the would-be spec without writing.
- Parsers: `validateGroupTimeout` (unlimited/unset/positive-int) and
  `applyGroupSpecChanges` (scalar + list-section replace), unit-tested.
- Member names validated against flag-injection (reuses `validateName`).

**`p4_protect_set` — deferred, NOT implemented.** Rationale: `p4 protect -i`
has no incremental form — it replaces the *entire* server protections table in
one write. A naive wrapper is a genuine lock-everyone-out foot-gun. A safe
version needs: read current table (`p4 protect -o`), a structured
add/remove/modify-line model layered on the raw spec, a mandatory preview diff,
and arguably a stricter gate than `p4_group_set` (e.g. refuse to remove the
caller's own `super` line). Design this deliberately; do not rush it onto the
back of the group writer.

## Verification (Phase 2)

1. `npm test` from the bridge dir → 129 pass (incl. the two gating spawn tests
   and the `validateGroupTimeout` / `applyGroupSpecChanges` unit tests).
2. `node --check server.mjs parsers.mjs`.
3. Live (needs a super-access P4 connection):
   - With `P4_ENABLE_ADMIN` unset → `p4_group_set` is not in the tool list.
   - With it `true` and a non-super user → `p4_group_set` returns the
     "requires 'super'" refusal without writing.
   - With super → `p4_group_set({ group, timeout: "unlimited", users:[...] })`
     previews the spec; `preview:false` applies it; re-read with
     `p4_group_info` to confirm.
