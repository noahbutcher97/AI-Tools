# Perforce MCP Bridge

Local stdio MCP bridge for Perforce workspace operations.

## Installer Fields

- `P4PORT`: Perforce server, for example `ssl:perforce.example.com:1666`.
- `P4USER`: Perforce username.
- `P4CLIENT`: Perforce client/workspace name.
- `P4DEPOT`: Depot path without leading slashes, for example `Project1/OnSight`.
- `P4PASSWD`: optional secret. Prefer a cached `p4 login` ticket when possible.
- `P4_ENABLE_ADMIN`: optional. Set to `true` to register server-global admin **write** tools (`p4_group_set`). Defaults to `false` — admin writers stay hidden and the install is workspace-scoped.

Secrets are stored in `.mcp.local.json`. Public workspace values are stored in `.mcp.json`.

## Tool Inventory

Read tools (no mutation): `p4_info`, `p4_opened`, `p4_changes`, `p4_describe`, `p4_diff`, `p4_filelog`, `p4_print`, `p4_annotate`, `p4_fstat`, `p4_where`, `p4_have`.

Admin / identity reads (server-global, no mutation): `p4_users`, `p4_groups`, `p4_group_info`, `p4_login_status`, `p4_protects`.

For pending changelists in this workspace, use `p4_changes` with `status: "pending"` and `client: "<workspace>"`.

To preview a reconcile without opening files, use `p4_reconcile` with `preview: true` (its default).

Open/close verbs: `p4_edit`, `p4_add`, `p4_delete`, `p4_revert`, `p4_reconcile`.

Lock/unlock (for binary asset workflows like Unreal `.uasset`/`.umap`): `p4_lock`, `p4_unlock`.

Changelist management: `p4_create_changelist`, `p4_update_changelist`, `p4_delete_changelist`, `p4_reopen`.

Move/rename: `p4_move`.

Sync + resolve: `p4_sync`, `p4_resolve`.

Submit + shelve + integrate: `p4_submit`, `p4_shelve`, `p4_unshelve`, `p4_integrate`, `p4_merge`, `p4_copy`.

## Mutation Safety Defaults

Every mutation tool defaults `preview` based on the cost asymmetry of the operation:

- **Caller-explicit + non-destructive** → `preview: false` (`p4_edit`, `p4_add`, `p4_shelve`, `p4_unshelve`). The caller named the target; preview would just add a round-trip.
- **Caller-explicit + destructive of pending or depot work** → `preview: true` (`p4_revert`, `p4_delete`). Forgetting preview loses real work.
- **State-driven or wildcard-fanout** → `preview: true` (`p4_reconcile`, `p4_integrate`, `p4_move`). Forgetting preview can scoop many files.
- **Benign** → no preview parameter (`p4_lock`, `p4_unlock`, `p4_update_changelist`, `p4_delete_changelist`, `p4_reopen`).

## Changelist Workflow

Create a numbered changelist:

```text
p4_create_changelist({ description: "My change description" })
```

Check out specific files for edit (direct checkout — file-driven, not state-driven):

```text
p4_edit({
  files: ["//Project1/OnSight/Source/Foo.cpp", "//Project1/OnSight/Source/Bar.cpp"],
  changelist: "12345"
})
```

Preview which files `p4 edit` would open (dry run via `-n`):

```text
p4_edit({
  files: ["//Project1/OnSight/Source/Foo/..."],
  preview: true
})
```

Use `p4_edit` when you want to open specific files *before* modifying them (standard pre-edit checkout). Use `p4_reconcile` (below) when you've already modified the workspace and want Perforce to detect adds/edits/deletes from on-disk state.

Open changes detected from workspace state directly into a changelist:

```text
p4_reconcile({
  path: "//Project1/OnSight/Source/...",
  preview: false,
  changelist: "12345"
})
```

Reopen already-opened files with `p4_reopen` — moves them between pending
changelists and/or retypes them. At least one of `changelist`/`filetype` is
required.

Move opened files into a numbered changelist:

```text
p4_reopen({
  changelist: "12345",
  files: ["//Project1/OnSight/Source/Foo.cpp"]
})
```

Move opened files back to the default changelist:

```text
p4_reopen({
  changelist: "default",
  files: ["//Project1/OnSight/Source/Foo.cpp"]
})
```

Retype an opened file (e.g. lock a binary asset), optionally moving it in the
same call:

```text
p4_reopen({
  filetype: "binary+l",
  files: ["//Project1/OnSight/Content/Hero.uasset"]
})

p4_reopen({
  changelist: "12345",
  filetype: "text+w",
  files: ["//Project1/OnSight/Source/Foo.cpp"]
})
```

Preview a depot file move/rename:

```text
p4_move({
  source: "//Project1/OnSight/Source/OldName.cpp",
  target: "//Project1/OnSight/Source/NewName.cpp"
})
```

Actually open the file move:

```text
p4_move({
  source: "//Project1/OnSight/Source/OldName.cpp",
  target: "//Project1/OnSight/Source/NewName.cpp",
  changelist: "12345",
  preview: false
})
```

Preview submit checks:

```text
p4_submit({
  changelist: "12345",
  description: "My change description",
  preview: true
})
```

Submit:

```text
p4_submit({
  changelist: "12345",
  description: "My change description"
})
```

For numbered changelists, `p4_submit` refuses to submit unless the provided description matches the changelist spec description after normalization. This prevents accidental description clobbering.

Update an existing pending changelist's description (preserves Files, Jobs, Type, and other spec fields):

```text
p4_update_changelist({ changelist: "12345", description: "Revised description" })
```

Delete an empty pending changelist:

```text
p4_delete_changelist({ changelist: "12345" })
```

## Add / Delete / Revert

Add new files to the depot:

```text
p4_add({
  files: ["Source/NewFile.cpp"],
  changelist: "12345"
})
```

Add binary assets with an exclusive-lock filetype (Unreal pattern):

```text
p4_add({
  files: ["Content/MyAsset.uasset"],
  filetype: "binary+l",
  changelist: "12345"
})
```

Mark files for delete (preview first by default):

```text
p4_delete({
  files: ["Source/OldFile.cpp"],
  preview: false,
  changelist: "12345"
})
```

Discard pending opens (revert previews by default — set `preview: false` to actually revert):

```text
p4_revert({
  files: ["Source/Foo.cpp"],
  preview: false
})
```

Close the open status but keep your edits on disk (the "I didn't mean to check this out" escape hatch):

```text
p4_revert({
  files: ["Source/Foo.cpp"],
  preview: false,
  keepWorkspaceFile: true
})
```

## Lock / Unlock

Acquire an exclusive lock on already-opened files (required for safe concurrent edits on `.uasset` / `.umap`):

```text
p4_lock({
  files: ["Content/MyAsset.uasset"],
  changelist: "12345"
})
```

Release the lock:

```text
p4_unlock({
  files: ["Content/MyAsset.uasset"],
  changelist: "12345"
})
```

## Shelve / Unshelve

Shelve files from a pending changelist:

```text
p4_shelve({ changelist: "12345" })
```

Overwrite an existing shelf with current open files:

```text
p4_shelve({ changelist: "12345", replace: true })
```

Unshelve into the default changelist:

```text
p4_unshelve({ sourceChangelist: "12345" })
```

Unshelve into a specific pending changelist:

```text
p4_unshelve({ sourceChangelist: "12345", targetChangelist: "67890" })
```

## Integrate / Merge / Copy

Three related branch operations — pick by intent:

- **`p4_integrate`** — base form. Sets up branch integration with conflict detection.
- **`p4_merge`** — merge-biased defaults; appropriate for general dev branch syncing.
- **`p4_copy`** — byte-identical replacement. No merging; target becomes a verbatim copy of source. Used for release promotion.

Note that `p4_merge` and `p4_copy` use **`-F` (capital)** for force, distinct from `p4_integrate`'s `-f` — the MCP tools normalize this; just pass `force: true` and the right flag goes through.

Preview a branch integration:

```text
p4_integrate({
  source: "//Project1/Main/...",
  target: "//Project1/Release/..."
})
```

Open a merge into a pending changelist:

```text
p4_merge({
  source: "//Project1/Main/...",
  target: "//Project1/Feature/...",
  changelist: "12345",
  preview: false
})
```

Promote a release branch via byte-identical copy:

```text
p4_copy({
  source: "//Project1/Main/Release/...",
  target: "//Project1/Public/...",
  changelist: "12345",
  preview: false
})
```

## Read Tools

Print a text file at a specific revision:

```text
p4_print({ path: "//Project1/OnSight/Source/Foo.cpp#42", quiet: true })
```

Print a binary file (returns JSON with base64 bytes — required for `.uasset`, `.umap`, compiled binaries, images):

```text
p4_print({ path: "//Project1/OnSight/Content/MyAsset.uasset", binary: true })
```

Binary mode auto-suppresses p4's text header, so the decoded base64 IS the file content. Cap is 50MB per call.

Line-by-line blame:

```text
p4_annotate({ path: "//Project1/OnSight/Source/Foo.cpp", followIntegrations: true })
```

Translate depot ↔ workspace paths:

```text
p4_where({ path: "//Project1/OnSight/Source/Foo.cpp" })
```

What's synced in this workspace:

```text
p4_have({ path: "//Project1/OnSight/Source/..." })
```

## Admin / Identity (read-only)

Unlike every other tool here, these report on the **whole Perforce server**, not
`//P4DEPOT/...`. Each response is wrapped with a `scope: "server-global"` field
(and a `warning` when the read is unscoped) following the scope-leak convention
in `_handoffs/2026-05-18-bridge-scope-leak-audit.md`. They require only the
access your configured `P4USER` already has — reading another user's tickets or
protections needs `super`.

Resolve a display name/handle to a real login:

```text
p4_users({ user: "keem" })      // one or more usernames
p4_users()                       // all accounts (server-wide; warns)
```

List a user's group memberships (or all groups):

```text
p4_groups({ user: "keem" })
p4_groups()                      // all groups (server-wide; warns)
```

Read a group spec — including `Timeout` (ticket lifetime) and members. Numeric
limit fields report `unset` when no limit is imposed:

```text
p4_group_info({ group: "keem_no_timeout" })
```

Check ticket status — the tool to reach for when a user reports a recurring
re-login "cooldown" (an expiring ticket). Returns `status` of
`valid` / `expired` / `unknown` plus `expiresInSeconds` when valid:

```text
p4_login_status()                // connected user
p4_login_status({ user: "keem" })// other users require super
```

Probe effective capability — answers "can this user perform an admin action
themselves?". With `max`, returns one of `list/read/open/write/admin/super`:

```text
p4_protects({ max: true })       // effective max access level
p4_protects()                    // raw protection lines that apply
```

These reads cover the common "why does user X keep getting logged out, and can
they fix it themselves?" workflow end-to-end: resolve the login (`p4_users`),
check existing groups (`p4_groups`), confirm the symptom (`p4_login_status`),
and confirm who has `super` (`p4_protects`).

## Admin / Identity (write — opt-in)

Disabled by default. Set `P4_ENABLE_ADMIN=true` to register these. They mutate
**server-global** state and require `super` access; each runs a `p4 protects -m`
capability pre-check first, so a non-super caller gets a clear
"requires 'super'; your level is '<x>'" error instead of a raw permission
failure mid-mutation.

`p4_group_set` creates or modifies a group spec. It reads the current spec
(or a fresh template for a new group), changes only the fields you pass, and
writes it back via `p4 group -i` — `MaxResults` / `MaxScanRows` / `MaxLockTime`
and any other fields are preserved. It **previews by default**; set
`preview: false` to apply.

Give a user a non-expiring ticket (the originating use case) — preview first:

```text
p4_group_set({ group: "keem_no_timeout", timeout: "unlimited", users: ["keem"] })
```

Apply it:

```text
p4_group_set({ group: "keem_no_timeout", timeout: "unlimited", users: ["keem"], preview: false })
```

`timeout` accepts `unlimited`, `unset`, or a positive integer of seconds.
Prefer a long-but-finite value over `unlimited` when you can — a leaked ticket
with `unlimited` never auto-expires:

```text
p4_group_set({ group: "keem_no_timeout", timeout: "1209600", preview: false })  // 2 weeks
```

`users` / `owners` / `subgroups`, when provided, **replace** that section's
entire membership (they are not additive). Omit a section to leave it untouched.

Protection-table writes (`p4 protect -i`) are intentionally **not** included:
that command replaces the whole server protections table at once and needs a
dedicated read-modify-write design to be safe. Tracked in
`_handoffs/2026-05-29-perforce-admin-tier.md`.

## Verification

```powershell
cd MCP-Servers/bridges/perforce
npm test
node --check server.mjs
```
