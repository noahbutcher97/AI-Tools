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

1. Restart the Codex daemon (stop the WindowsApps process) and test whether the
   granular `approval_policy` lets `relay_send` through. Verify the new daemon's
   start time first.
2. Execute `docs/superpowers/plans/2026-08-26-typed-messages.md`.
3. Rungs 2–4 of the typed-message ladder each need their own design pass. Rung 4
   reopens a rejected decision deliberately and should not be reached by
   accretion.
