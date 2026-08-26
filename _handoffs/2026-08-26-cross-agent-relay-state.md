# Cross-Agent Relay — State Snapshot

Date: 2026-08-26
Purpose: durable handoff for whoever continues this, including a later session
of the same agent. Written because the machine configuration changed and several
findings live only in a conversation.

## Where things stand

The relay bridge is **built, tested and committed**. 212 tests, working tree
clean, 11 commits on `main` from `1935273` to `ec4ca39`.

| Unit | State |
|---|---|
| 1 — discovery + `list` | Delivered |
| 2 — `send` to Codex, spool, failure taxonomy | Delivered |
| 3 — MCP face + `claude -p` delegate | Delivered **except** Codex→Claude send, blocked; see below |
| 4 — `summary` / `read` | Delivered, both agent kinds |
| 5 — `--re` threading with excerpts | Delivered, both agent kinds |
| Typed messages (rung 1) | **Designed and planned, not built** |

Design docs, in dependency order:

- `docs/superpowers/specs/2026-08-23-cross-agent-relay-design.md` — Units 1–5,
  and every measured fact about both vendors' session stores.
- `docs/superpowers/specs/2026-08-25-typed-messages-design.md` — rung 1 of the
  typed-message ladder.
- `docs/superpowers/plans/2026-08-26-typed-messages.md` — 10 tasks, 52 steps,
  ready to execute.

## The one thing that is blocked

**`relay_send` cannot be invoked from a Codex session.** It fails with
`MCP tool call requires approval, but approval policy is never`.

What has been tried, each with a freshly restarted daemon confirmed by pid:

| Attempt | Result |
|---|---|
| `approval_mode = "auto"` on the tool | refused |
| `approval_mode = "prompt"` | refused |
| `approval_mode = "writes"` | refused |
| global `approval_policy = { granular = { mcp_elicitations = true, … } }` | **untested** — set, daemon never restarted after |

The last row is the next thing to try. Official reference confirms `"never"`
means *auto-reject all approval requests*, and `mcp_elicitations: true` makes MCP
prompts *appear instead of being auto-rejected*, which matches the symptom
exactly. Whether Codex classifies a tool-call approval as an "elicitation" is
unverified.

**Why this matters beyond convenience:** a relay invoked from a Codex *shell*
command cannot deliver to a Claude session at all — `~/.claude/sessions` is
outside the workspace sandbox, so the delegate sees no peers
(`ListAgents → "No reachable agents"`). The MCP face is spawned by the Codex
parent and reads that registry normally. So the MCP tool is the **only** route
for Codex→Claude, not a nicer one.

## Machine configuration changed — how to revert

All outside the repository. Each has a backup.

| File | Change | Backup |
|---|---|---|
| `~/.codex/config.toml` | `[mcp_servers.relay]` registration | `config.toml.bak-relay-20260823` |
| `~/.codex/config.toml` | `[mcp_servers.relay.tools.relay_send] approval_mode` | `config.toml.bak-relay-approval-20260824` |
| `~/.codex/config.toml` | `approval_policy` `never` → granular object | `config.toml.bak-global-policy-20260824` |
| `~/.claude.json` | top-level `mcpServers.relay` | `.claude.json.bak-relay-20260825` |

Also created: `~/.cross-agent-relay/spool.log`, containing only labelled
development probes — safe to delete.

**Left deliberately:** one undelivered probe sits in `~/.codex/queue_1.sqlite`
addressed to dead thread `01a02f8e-6c28`. Removing it means writing to Codex's
own database, and relay-side manipulation of that queue is the first step toward
the second delivery path the design rejects. Noah's call, not the tool's.

## Environment facts that cost time to learn

**Two Codex installations coexist.** The TUI is npm
(`~/AppData/Roaming/npm/...`); the **app-server daemon is the WindowsApps/Store
build**. Closing TUI windows and updating the npm package do not touch the
daemon, which is what holds cached config. Restarting "Codex" in the obvious way
therefore does nothing to a config change.

**`codex app-server daemon restart` is Unix-only.** On Windows the only route is
stopping the process. Identify it by `CommandLine -like '*WindowsApps*'`.

**Config is daemon-cached.** After any `config.toml` edit, verify the daemon's
start time postdates the file's mtime *before* believing any result. Two
"definitive" findings in this project were measured against a stale daemon.

**`tasklist /FI` is mangled by Git Bash** — the flag becomes a filesystem path
and the command reports zero processes while many are running. Use PowerShell
`Get-CimInstance Win32_Process` for anything process-related.

**Bash heredocs silently halve `\\`.** This corrupted test fixtures early on and
broke two mutation probes later. Use Write/Edit for any content with backslashes.

**Run tests from the bridge directory.** `node --test` at the repo root picks up
unrelated suites and reports meaningless totals.

## Findings that shaped the design, in one line each

- A Codex lock file **outlives its session** — proven with every Codex process
  stopped and locks still present. Lock presence over-reports liveness.
- `codex queue` returns **exit 0 with a success string** for a dead thread; the
  message waits in `queue_1.sqlite`, possibly forever. Output parsing cannot
  detect this; only a pre-flight check can.
- Both hosts publish session identity in the environment
  (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`), so origin is genuinely
  verifiable on every path. `CLAUDE_CODE_MESSAGING_TOKEN` sits beside it and is
  never read.
- Codex's `state_5.sqlite` `threads` table supersedes walking rollout files;
  1648 of 1723 stored cwds carry the Windows `\\?\` prefix and must be stripped.
- A `claude -p` delegate registers as an ordinary session
  (`entrypoint: "sdk-cli"` is the only discriminator) and is filtered out.

## Next actions, in order

1. From a live Codex session, call `relay_list`. It needs no approval, so its
   result separates the two candidate barriers: success means deferred tools are
   callable and only approval is open; failure means deferral is the barrier and
   the approval work below is premature. Costs one prompt and no restart.
2. Do **not** restart the Codex daemon for this. It is not needed and would not
   help: see "Config reaches running sessions" below. Just attempt a `relay_send`
   from a session whose settings already carry the granular policy. The
   2026-08-24 record shows the refusal text to expect if it is still refused.
3. Execute `docs/superpowers/plans/2026-08-26-typed-messages.md`.
4. Rungs 2–4 of the typed-message ladder each need their own design pass. Rung 4
   reopens a rejected decision deliberately and should not be reached by
   accretion.

## Rollout forensics, 2026-08-26: what the MCP route actually does

Reading the Codex rollout corpus (719 files under the Codex sessions tree)
settled several questions that argument had not.

**relay_send is callable from Codex, and was called.** Session 01a034fa on
2026-08-24 invoked it four times, and relay_list once. Every relay_send
returned the same output:

    MCP tool call requires approval, but approval policy is never

relay_list succeeded in the same session and returned the full target list,
because it is annotated readOnlyHint and needs no approval. The two tools
differ in nothing else that bears on delivery, which isolates the barrier to
the approval layer rather than to transport, registration, or the sandbox.

**Tool deferral was not the barrier it appeared to be.** Only the first of
those five calls had a tool_search in the same turn; the remaining four had
none. Once discovered, the tools stayed callable across later turns of that
session, so discovery is not per-turn as was assumed.

**A Codex update landed in the middle of the record.** The installed package
files were rewritten 2026-08-24 at 18:02 local, after the working calls at
14:15-14:38 local. The shipped binary carries feature flags named
tool_search_always_defer_mcp_tools, deferred_tool_world_state and
unavailable_dummy_tools, and a tool_search run on 08-26 returned relay_send
carrying defer_loading true.

**The corpus cannot say whether that update broke anything.** Since the update
there has been exactly one tool_search, and that one search was a diagnostic
that explicitly told the session not to call the tool.

> **Corrected 2026-08-26.** This paragraph originally also claimed "zero MCP
> tool calls of any kind across 155 rollouts". That was a false finding produced
> by the scan, not by the record. The scan counted `function_call` items whose
> `namespace` began `mcp__`, which is the shape MCP calls had *before* the
> update. Under code mode they are recorded as `custom_tool_call` items of type
> `exec` whose script body calls `tools.mcp__server__tool(...)`, so the scan
> could not have found one however many there were. Guard 4 in the spec asks for
> the instrument and what it ranges over; the instrument was named and the
> population was not.

**The discriminating test is relay_list, not relay_send.** relay_list requires
no approval, so invoking it from a current Codex session separates the two
candidate barriers in one step: if it returns targets, deferred tools are
callable and approval policy is the only open question; if it fails, deferral
itself is the barrier and the approval work is premature.

### Claims retracted here

- That code mode is why the tools are not callable. Code mode and MCP Tool
  Search are separate features and the deferral flag belongs to tool search.
  Code mode is still undescribed in this record; nothing should be disabled on
  the strength of the earlier reasoning.
- That the model never attempted the call. In the turn cited it had been
  instructed not to call. Its later reports of an uncallable tool are
  self-reports about a tool surface, uncorroborated by any tool output.

## Config reaches running sessions without a daemon restart

Session 01a03e2c emitted `thread_settings_applied` at 2026-08-26T13:16:16Z
carrying the granular approval policy, while the session itself had started at
13:05Z and kept running. Codex hot-applies configuration to live sessions; the
earlier assumption that a daemon restart was required to pick up the approval
change is wrong, and the action list above has been corrected.

Every `relay_send` failure in that session (13:06:59, 13:09:23, 13:12:30,
13:13:41) predates 13:16:16Z. The granular policy has therefore never been
tested against an actual call, and the four refusals should not be cited as
evidence against it.

**A restart would also have been aimed at the wrong process.** The relay MCP
server runs as a child of each TUI process, not of the app-server. Session
scoping follows the TUI: three TUIs were live, each with its own relay server
child, and one TUI predated the running app-server by two days. Restarting the
app-server neither reloads a session's MCP servers nor ends its TUI.

**Two session settings worth knowing when reading agent behaviour here.**
`reasoning_effort` is `low` and `personality` is `pragmatic`. A low-effort
session that meets a deferred tool is likelier to report the obstacle than to
work around it, which is consistent with what the 08-26 transcript shows and is
not by itself evidence that the tool was uncallable.

**The sandbox profile explains the spool fallback.** The permission profile is
`managed`/`restricted`, granting write only to the project root, the Codex
memories directory, and the temp directories. The relay's default spool path
under the user profile is not writable from there, which is why the temp-dir
fallback is load-bearing rather than defensive.

## Resolved 2026-08-26: Codex to Claude works, and what code mode is

Session 01a03e2c called both relay tools successfully at 15:06-15:12Z. The send
returned `ok: true` and the message arrived in the Claude target. **The
Codex-to-Claude direction is unblocked**, and the granular approval policy is
sufficient - no daemon restart and no per-tool `approval_mode` change was needed
to get there.

**Code mode, described from the record rather than inferred.** Codex exposes
each MCP tool to the model as a TypeScript declaration and the model invokes it
from JavaScript inside an `exec` sandbox:

    declare const tools: { mcp__relay__relay_send(args: {...}): Promise<CallToolResult>; };

The working call was literally:

    const send = await tools.mcp__relay__relay_send({to:"ai-tools-dd", message:"approval test"});

A global `ALL_TOOLS` array is available in the same sandbox and the session used
`ALL_TOOLS.filter(...)` to find the relay entries. This is why no `function_call`
item names an MCP tool after the update, and why `tool_search` results looked
like a dead end.

**An earlier session's self-report was accurate and was wrongly discounted.** On
08-26 a session reported that `mcp__relay.relay_send` was "not directly callable
in this session's tool surface". That is exactly right: under code mode the tool
is not directly callable, it is callable from code. The report was recorded here
as unreliable introspection. It was correct, and more precise than the reading
that replaced it.

### Open defect: no verified origin on the Codex-to-Claude MCP path

The delivered envelope carried `From: not stated by the sender. No reply address
is available.` The sending session supplied no `from` argument and
`detectVerifiedOrigin()` found nothing, so a message that genuinely originated
in a known Codex thread arrived anonymous and unreplyable.

This is asymmetric with the reverse direction: Claude-to-Codex messages carry a
VERIFIED origin, because the relay server spawned by `claude.exe` inherits
`CLAUDE_CODE_SESSION_ID`. The requirement that origin work across the whole
provider matrix is therefore not met on this path.

**Cause established 2026-08-26 by reading the environment blocks of the running
relay server processes.** Candidate 1 is confirmed and candidate 2 (a stale id)
is ruled out:

| relay server spawned by | env vars | origin variable |
|---|---|---|
| Codex TUI (three processes) | 18 | none; no `CODEX_*` at all |
| `claude.exe` (two processes) | 74 | `CLAUDE_CODE_SESSION_ID` with a live value |

The Claude-spawned servers acted as a positive control, so the probe is known to
see the variable when it is present. One of the Codex servers had been spawned
in the same second its thread started, so freshness was never the issue - the
variable is **absent, not stale**.

This is structural rather than a misconfiguration. Codex scrubs the environment
of processes it spawns to a core subset, and `[mcp_servers.relay]` carries no
`env` block. It could not usefully carry one: a thread id is per-thread and the
server is spawned once per TUI.

**A thread id cannot be recovered from the host either.** The `threads` table in
`state_5.sqlite` has no pid column, and the files in `thread-writer-locks` are
zero-byte, so neither store maps a TUI process to the thread it is currently on.
Mapping a held lock back to a pid needs OS handle enumeration, which is both
fragile and the kind of process introspection that should not be built into a
messaging bridge.

**What relay can still establish on this path, without the caller's help:**

- the **host process**, from `process.ppid` - the Codex TUI is identified by the
  OS, not by anything the sender supplied;
- the **workspace**, from the server's own working directory, which Codex sets
  from the session;
- whether a **claimed** thread id is live and sits in the same workspace, by
  checking it against the thread index.

That last check is far weaker than it first reads, and the measurement matters
more than the argument. Querying the thread index: **1,514 unarchived threads
share the OperationPhoenix workspace, 304 of them touched within seven days.** A
workspace check therefore admits any of several hundred live threads, including
threads the caller was never on and threads belonging to a different concurrent
TUI in the same tree. Its real content is "this id is a live thread in this
workspace", not "this id plausibly belongs to this caller". Stating it as the
latter repeats guard 4 - constraining a thread-level claim with a
workspace-level fact.

The honest envelope wording is therefore closer to *workspace verified, thread
claimed* than to anything using the word corroborated.

**Note also what `process.ppid` does and does not buy.** It identifies the
calling TUI from the OS, but a TUI is not addressable: `codex queue` needs a
thread id. So the ppid supports diagnostics and cannot supply a reply address.
Any option should be assessed against both halves of the requirement separately
- saying who called, and giving somewhere to reply - because this path can
currently satisfy the first without the second.

### The cheap unknown to settle first

Whether Codex passes anything identifying in the MCP `initialize` handshake is
unanswered and would make the question above moot if it does. `clientInfo`
arrives on every MCP connection; if it carries a thread id, origin on this path
is solved outright and no corroboration scheme is needed. Settling it costs a
logging line in the relay server plus one newly started Codex session, and it
should be done **before** any design work on origin wording, not after.
