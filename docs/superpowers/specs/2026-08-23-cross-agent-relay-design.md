# Cross-Agent Relay - Design

Date: 2026-08-23
Status: Design approved in principle; spec pending Noah review
Author: Claude (session operationphoenix-b1)

## 1. Purpose

Give any agent session on this machine the ability to (a) discover the other
agent sessions, (b) read what they are doing at a useful altitude, and
(c) inject a prompt into them, across both Claude Code and Codex.

The tool is machine-global infrastructure, not an OnSight artifact. It works in
any project. Workspace is a default filter, never an architectural boundary.

## 2. Non-goals

Explicitly out of scope, each for a stated reason:

- **A handoff system.** Handoffs between Claude/Claude, Codex/Codex and
  Claude/Codex are generally useful and deserve their own design with their own
  addressing model, lifecycle and acceptance semantics. Shoehorning them into
  live messaging would produce a worse version of both. Decided 2026-08-23.
- **Deferred delivery** ("leave a prompt for a session that does not exist
  yet"). This is the handoff system's job, not this one's.
- **Speaking the Claude peer pipe protocol directly.** See section 4.4. A
  sanctioned client does the delivery instead. No reverse engineering, no key
  handling, no version gate.
- **A redundant fallback transport.** Rejected during design: a second delivery
  path is never exercised, rots, and introduces duplicate-delivery, reordering,
  racing-drain and ambiguous-addressing failures. Failure handling is a spool
  plus a loud error instead (section 8).

## 3. Measured facts

Everything below was measured on 2026-08-23, not assumed. Re-verify before
relying on any of it after a Claude Code or Codex update.

### 3.1 Claude session registry

`~/.claude/sessions/<pid>.json`, one file per live session:

```
pid, sessionId, cwd, startedAt, version, kind, entrypoint,
peerProtocol, peerFeatures, messagingSocketPath,
name, nameSource, status, updatedAt, statusUpdatedAt
```

`name` is the address used by `SendMessage`. `status` is `busy` or `idle`.
`cwd` gives workspace scoping. A sibling `<pid>.<sha>.key` file holds the pipe
auth secret; this design never reads it.

### 3.2 Native Claude delivery wakes idle sessions

Session `operationphoenix-17` had been idle since 2026-08-22 19:23:45.

```
12:05:35  idle -> busy   (SendMessage arrives)
12:05:48  busy -> idle   (processed, 13s)
```

Confirmed again against `operationphoenix-ea` (idle ~20h) via the delegate
path in 3.4. Delivery wakes a fully idle session with no human input.

### 3.3 Codex thread storage

Two stores coexist:

- **Legacy rollout JSONL** at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
  First record is `session_meta` carrying `id`, `cwd`, `originator`,
  `thread_source`, `parent_thread_id`, `agent_role`, `agent_nickname`.
- **Current thread store** at `~/.codex/thread_history_1.sqlite` (411MB on this
  machine). Tables: `thread_turns`, `thread_items`,
  `thread_history_projection_state`.

`thread_turns` columns:

```
thread_id, turn_id, rollout_ordinal, status, error_json,
started_at, completed_at, duration_ms,
first_user_item_id, final_agent_item_id,
rollout_byte_offset, rollout_end_ordinal, rollout_end_byte_offset
```

This table is a purpose-built index: stable `turn_id`, turn status and timing,
and byte offsets into the rollout for each turn. The conversational read layer
is largely a projection of it.

**Live-thread registry:** `~/.codex/thread-writer-locks/<thread-id>.lock`, one
per live thread. This is the Codex equivalent of the Claude session registry and
is more reliable than rollout file mtimes, which do not track appends on Windows.

Measured while building Unit 1, three refinements to that directory:

- It also holds `.coordination.lock`, which is not a thread. The filter must be
  thread-id shaped, not `*.lock`.
- Its contents churn on the order of seconds. Across four listings a few minutes
  apart, `.coordination.lock` and two thread locks appeared and vanished while a
  rollout for one of them was still being appended to. Locks are a snapshot of
  what is live right now, not a durable roster.
- Subagent threads take locks too. A sample of 5 live locks held 2 root chats
  and 3 subagents (`agent_nickname` "Bacon the 2nd", "Descartes the 2nd", "Dirac
  the 2nd"). The `thread_source == "user"` filter below is what makes the lock
  directory usable as a target list rather than a view of other agents'
  internals.

**Codex keeps its own thread index, and it is the better source.** Measured
2026-08-24: `~/.codex/state_5.sqlite`, table `threads`, 1723 rows carrying
`id`, `rollout_path`, `cwd` and `thread_source` per thread. Reading it replaces
the rollout directory walk *and* the per-thread first-line read, and removes the
dependence on the rollout filename convention entirely. Full discovery against
the live machine: **13ms**, against ~32ms for the walk alone.

Two fields in that table are traps at face value:

- **1648 of 1723 `cwd` values carry the Windows extended-length prefix**
  (`\\?\D:\...`), which does not compare equal to the plain path a caller
  passes. Comparing raw would make scope filtering miss almost every real
  session. Stripped on read.
- **`thread_source` is null on 74 rows.** Guessing either way is wrong: "user"
  would offer subagent internals as targets, "subagent" would hide real
  sessions. Those rows fall back to reading the rollout — at the *indexed* path,
  so still no directory walk.

`source = 'cli'` is not a usable substitute for `thread_source`: cross-tabulated,
it misses 8 user threads and covers only 190 of 198.

The filename-convention walk is retained solely for what the index cannot cover —
an older install with no `state_5.sqlite`, or a live thread it has not recorded —
and a locked thread absent from the index is reported unaddressable rather than
dropped.

**`thread_turns` carries neither `cwd` nor `thread_source`.** The full column
list in this section is exhaustive; both fields live only in the rollout's
`session_meta` first record. Codex discovery is therefore necessarily a
sqlite-plus-rollout join, keyed by the thread id that the rollout filename ends
with. A full walk of `~/.codex/sessions` measured 32ms across 1684 files, so the
join is cheap enough to do once per discovery.

**Use `session_meta.payload.id`, never `payload.session_id`.** For a forked or
subagent thread, `session_id` carries the *root* thread's id: thread
`01a02f2a-5dca` carries `session_id` `01a020bf-943f` alongside `forked_from_id`
and `parent_thread_id` pointing at the same root. Keying on `session_id`
collapses distinct threads onto their parent.

**`thread_turns.started_at` and `completed_at` are unix SECONDS**, while the
Claude registry's `startedAt`, `updatedAt` and `statusUpdatedAt` are
milliseconds. Confirmed against lock mtimes: thread `01a02f38-aea9` had lock
mtime 1787507497690.3ms and `max(started_at)` 1787507497. Any layer that mixes
the two is wrong by 1000x, so normalize at the boundary and pin it with a
fixed-clock test.

**Turn status values** observed across the whole store: `completed` (386),
`interrupted` (46), `failed` (3), `inProgress` (3). Only `inProgress` means
busy; `interrupted` is a human-stopped turn and leaves an ordinary idle thread.

**Subagent filtering:** over 2026-08-21..23, this workspace had 132 Codex threads
of which only 3 were root user chats. Filter on `thread_source == "user"` to
separate real chats from subagent threads.

### 3.4 Codex sandbox blocks network for spawned commands

`sandbox_mode = "workspace-write"` with `network_access = false` means every
command Codex spawns is offline, while Codex's own model calls succeed because
they run in the parent process. Measured: `claude -p` inside `codex sandbox`
returned `API Error: Connection refused`.

**MCP servers are spawned by the Codex parent process, not through the command
sandbox.** This is why the existing `perforce`, `atlassian`, `miro` and `uemcp`
bridges reach the network from Codex at all. An MCP server is therefore the
clean sandbox crossing, and is the design's Codex-side entry point.

Note: `network_access` was set to `true` on 2026-08-23 at Noah's request, as an
independent decision. The design does not depend on it. Backup at
`~/.codex/config.toml.bak-network-20260823-131111`.

**That change did not take effect immediately.** A repeat of the same sandbox
test after the edit still returned `Connection refused` after 178s. The shared
app-server daemon caches sandbox state, so a daemon or session restart is
required. This is the same caching noted in section 7 and is worth remembering
for any future config change: verify the new setting is live before treating a
sandbox result as evidence of anything.

Also observed: `codex sandbox bash -c ...` fails with
`Bash/Service/CreateInstance/E_ACCESSDENIED`; bare command names fail
`CreateProcessAsUserW` and require absolute paths.

**Superseded 2026-08-24: the sandbox this section describes is no longer
closed, so the claim built on it is now untestable rather than proven.**
Measured from a real Codex session started after registration, running the
control exactly as written:

```
echo say hi | claude -p --allowedTools SendMessage
  -> exit 0, "Hi! What can I help you with today?"
```

No `Connection refused`. The `network_access = true` edit of 2026-08-23 took
effect once the daemon restarted, so a Codex **shell** command now reaches the
network directly. The premise of 3.4 — that spawned commands are offline and an
MCP server is therefore the clean crossing — does not hold in this
configuration.

Consequences, stated separately so they are not conflated:

- **The MCP-as-sandbox-crossing claim is untestable here**, not disproven.
  Re-testing it requires setting `network_access = false`, restarting the
  daemon, and re-running. It was never re-measured under the closed sandbox.
- **The MCP face keeps its other justification** (4.1): message payloads are
  multi-line prose and shell quoting corrupts them. That reason is independent
  of the sandbox and was demonstrated in Unit 2.
- This is exactly the confound the acceptance criterion was designed to catch.
  Had the control been skipped and only the MCP path run, a success would have
  been read as "the MCP path crosses the sandbox" when nothing was being
  crossed.

### 3.6a Codex refuses un-annotated MCP tools outright

Measured 2026-08-24 in the same run. `relay_send` was dispatched with correct
arguments and **failed before reaching the server**:

```
MCP tool call requires approval, but approval policy is never
```

The recorded `mcpToolCall` item shows `readOnlyHint: null`. Codex's
`approval_policy = "never"` means it never prompts, so any tool that looks
side-effecting is refused rather than queued for approval. A bridge can
therefore be correctly registered, load cleanly, and appear in the tool list
while being **entirely uninvokable**.

The fix is server-side annotation, not configuration: `relay_list` declares
`readOnlyHint: true` (it reads two registries and nothing else), and
`relay_send` declares `readOnlyHint: false, destructiveHint: false` — it adds a
message and removes nothing. Annotating `relay_send` read-only to dodge the
prompt would be a lie told to the host's own safety layer, and is not done.

**Verified in production, both directions of the result:**

```
relay_list   readOnlyHint: true    -> completed, returned live targets
relay_send   readOnlyHint: false   -> "requires approval, but approval policy is never"
```

So the annotation is *sufficient* for a read-only tool and *correctly
insufficient* for a side-effecting one. A tool that honestly declares side
effects cannot be invoked under `approval_policy = "never"` without explicit
per-tool configuration.

Valid per-tool values, discovered by feeding an invalid one to
`codex mcp list -c mcp_servers.relay.tools.relay_send.approval_mode=bogus`:

```
auto, prompt, writes, approve
```

Making `relay_send` usable from Codex therefore requires an operator decision —
`[mcp_servers.relay.tools.relay_send] approval_mode = "auto"` grants every Codex
session unprompted authority to message other agent sessions, including through
the `claude -p` delegate. That is a capability grant, not a bug fix, and belongs
to whoever owns the machine.

**Neither `prompt` nor `auto` took effect, and the daemon is the likely reason.**
Both were tried in turn, each with the Codex session restarted and a freshly
spawned relay server process confirmed by pid and start time. Both produced the
identical error.

That result is self-diagnosing: if `auto` were reaching the enforcement layer,
the tool would not "require approval" at all. So the setting is not being read.

The app-server daemon had been running since two days before either edit. **This
is the daemon-config caching of 3.4 and section 7, and it is broader than
recorded there** — it was first measured on `sandbox_mode`/`network_access`, and
now also covers `mcp_servers.*.tools.*.approval_mode`. Restarting the *session*
and the *MCP server* is not sufficient; the daemon holds the config.

Not yet confirmed, because confirming it means `codex app-server daemon restart`,
which interrupts every live Codex session on the machine. Interrupts, not
destroys — threads resume by id (`codex resume <id>`), so the cost is work in
flight rather than the session. The generalised warning stands regardless:
**after any `config.toml` change, verify the setting is live before treating a
result as evidence — a restarted session is not a restarted daemon.**

**There is no supported way to restart that daemon on Windows.** Measured
2026-08-24:

```
> codex app-server daemon restart
Error: codex app-server daemon lifecycle is only supported on Unix platforms
```

This makes the caching problem substantially worse on this platform than the
earlier entries imply. A `config.toml` change affecting anything the daemon
holds cannot be applied deliberately — it takes effect only when the daemon
happens to restart for some unrelated reason. The remaining options are to stop
the process directly, which is not the sanctioned lifecycle and is an operator
decision, or to wait.

Practical consequence for anyone reading this later: **verify the setting is
live before treating any result as evidence**, because on Windows the usual
"change the config and restart" loop is not actually available, and a test run
after an edit is very likely testing the old value.

**To resume this test** (deferred 2026-08-24 until the busy OperationPhoenix
session reaches a pause):

1. `codex app-server daemon restart` — Unix only; see above
2. Confirm the daemon pid actually changed — the whole point is that the old one
   was serving stale config, and reading a second failure as a design result
   would repeat the mistake this section documents.
3. Open a Codex TUI session and call `relay_send`. `auto` is already in
   `config.toml`, so **the capability activates on that restart without further
   edits** — a latent grant worth being aware of rather than surprised by.
4. If it still fails with `auto` live and confirmed, the conclusion flips: a
   global `approval_policy = "never"` is absolute and per-tool modes cannot
   override it. That would make Codex→Claude sending impossible without
   loosening the global policy, which is a much larger decision.

**A limitation of the design this exposed, worth stating plainly:** the relay can
*reach* Codex sessions but cannot *create* them. MCP servers load at session
start and sessions are TUI windows a human opens; `codex exec` spawns a session
non-interactively but loads **no MCP servers** and has no flag to change that
(verified 2026-08-24 — the tool was simply absent from that session). So the
relay's own test loop depends on a human opening windows. For a tool whose
purpose is agent-to-agent coordination, that is a real gap.

### 3.5 Codex queue works, with one constraint

```
codex queue --thread <uuid|name> --message <text>
```

Confirmed delivering into a live TUI thread. **A thread with zero turns is not
addressable** - it returns `no rollout found for thread id`. The target must
have taken at least one turn. Both early failures in testing were this, not a
broken transport.

Consequences for `list`: a freshly spawned Codex session is a real session but
not yet a valid target. Surface `turns: 0` as **not yet addressable** rather
than listing it as sendable, so the caller gets a meaningful state instead of a
confusing delivery error.

`--thread` also accepts an exact session name — `codex queue --help` documents
it as "Session UUID or exact session name". Unused here regardless: Codex user
threads carry no name in `session_meta`, so there is no source to resolve one
from. Discovery resolves to a uuid instead.

**Measured 2026-08-23 while building Unit 2 — four distinct queue outcomes.**
The two that matter are the last two.

| Target state | Exit | Output |
|---|---|---|
| thread id does not exist | 1 | `no rollout found for thread id <id> (code -32603)` |
| dead subagent thread | 1 | `direct app-server input is not allowed for unloaded spawned sub-agents (code -32600)` |
| **dead root user thread** | **0** | **`Queued message <id> for thread <id>.`** |
| live root user thread | 0 | same success line |

**Exit status and output parsing together cannot tell the last two apart.** The
dead-thread case is not an error the CLI reports badly — it is a genuine success
string with a genuine exit 0, textually identical to a real delivery. Any relay
that decides success from what `codex queue` returns will report delivery into a
session that is not running.

Where the message goes: `~/.codex/queue_1.sqlite`, table `queued_items`
(`id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms`).
Verified by locating the exact reported message id there after the probe, with
the probe text intact in `payload_json`. So the message is **durably queued, not
discarded** — a dead thread's queue holds it until that thread is resumed,
possibly forever. This is the reason the honest success wording is "queued",
never "delivered" or "sent".

For an orchestration tool, deferred is arguably worse than lost: a message
queued to a thread that later comes back alive is delivered on resume, hours
later and out of order with everything sent since. Recorded as a measured fact;
Unit 2 builds on it in neither direction, and simply refuses to queue into a
thread it cannot see as live.

**Lock presence is NOT a sufficient liveness signal. Proven 2026-08-24, and this
supersedes the earlier conclusion in this document.**

Earlier the concern was raised that a restart might leave a lock behind, probed
against a thread that turned out to be live, and closed as "lock presence remains
a valid liveness signal". That conclusion was correct for the case tested and
wrong as a general rule.

Measured with every Codex process stopped — zero TUI sessions and the app-server
daemon terminated, confirmed by process enumeration returning nothing:

```
locks still present:  4
relay still reports:  01a020bf-943f-…  [codex]  idle  102 turns  — addressable
```

Nothing can be live when no process exists, so this is a **proven false positive**
in the addressability signal, not a suspected one. Locks are removed on some
exits and not others: an earlier measurement found a cleanly-ended thread with
its lock gone, while these four survived their sessions.

The consequence is the failure this design exists to prevent. Relay would report
that thread addressable, `codex queue` would accept a message with exit 0, and it
would sit undelivered in `queued_items` until the thread is resumed — possibly
never. The pre-flight re-check does not help, because the lock it re-reads is the
thing that is wrong.

**The process-enumeration guard was implemented in outline, then rejected.** It
would have been a necessary condition — no Codex process implies no live thread —
but it fails on two counts measured 2026-08-24:

- **Cost.** No daemon pid file or named pipe exists to key off, so it needs a
  process listing per check. `tasklist` measured ~150ms and PowerShell more,
  against 13ms for the whole of discovery.
- **Failure direction, which is disqualifying.** `tasklist /FI` invoked through
  this project's shell was silently mangled — the flag became a filesystem path —
  and returned *zero* processes while six were running. A guard built on that
  would refuse every send while Codex works normally. **A false negative here is
  worse than the false positive it fixes**, because it breaks the working case
  rather than the broken one.

**What was implemented instead: a queue-backlog check.** `queue_1.sqlite` already
records undelivered messages per thread. A message still pending past the wake
threshold does not *infer* liveness — it **proves non-consumption**, whatever the
lock says. The check is one indexed query, costs nothing, and refuses the send
under its own cause (`target_not_consuming`) naming the backlog size and age.

Two properties hold it in place, both mutation-tested:

- **It fails open.** An absent or unreadable queue store lets the send proceed,
  because a guard that failed closed would block all traffic on any install
  lacking the store — repeating in a new form the exact mistake that disqualified
  process enumeration.
- **The threshold is 30s**, three times the largest measured wake latency, so
  ordinary in-flight traffic is never read as a stall. Dropping it makes
  back-to-back sends fail.

**What this does and does not cover.** It catches a thread that has *already*
failed to consume, which is the case that silently accumulates. It does not catch
the *first* message to a thread that has just died — nothing cheap can, since
that thread's queue is still empty at send time. Stated as a residual limit
rather than closed.

**Reading that signature requires a wait of at least ~30 seconds.** "The queued
row persists" is an absence-based negative, and an absence only means anything
relative to a timeout longer than the positive case takes.

**The threshold rests on one clean measurement, not a distribution.** Say so
plainly, because four figures were quoted in support of it and only this one
measures the quantity:

```
wake latency = codex queue returning -> the target's turn row appearing

  9.3s   n=1, precise.  queued 20:03:29.7Z, turn started 20:03:39Z
         (that turn then ran 2.8s, for 12s queue-to-completion)
```

Three figures that do **not** qualify, and why:

| figure | what it actually is |
|---|---|
| 6s | a poll-limited **upper bound** — the poller slept 6s then found the row count risen, and never recorded its queue timestamp, so it cannot be decomposed. Consistent with 9.3s; not an observation of the system. |
| 9.0s | turn `duration_ms` (9027) on the 23-hour-idle thread in 3.5. Not a latency. |
| 13s | Claude-side idle→busy→idle in 3.2. A different system. |

~30s is **margin over the single precise figure** — roughly 3x, on a system where
nothing forces wake to be fast. It is not derived from a spread. Anyone wanting
a real distribution should record queue timestamps and take five.

A check made before the threshold elapses produces a **false dead verdict**.
Measured the hard way: a check ~2s after queueing found the row still pending,
which is exactly the dead-thread signature, and the message was consumed moments
later.

The subagent refusal (`-32600`) is worth noting on its own: subagent threads hold
locks and appear live, but cannot be queued at all once unloaded. The
`thread_source == "user"` filter already excludes them from discovery, which is a
second reason it is load-bearing rather than cosmetic.

The consequence for the design is that the guard must be **pre-flight, from
liveness**, not post-hoc from the queue's own report. See section 6.

**`codex queue` wakes an idle Codex session, the same way native delivery wakes
an idle Claude one (3.2).** Measured against thread `01a02a7a-580b`, idle since
2026-08-22 19:02:44 — roughly 23 hours:

```
turns 14 -> 15, new turn started within seconds of the queue landing
queued_items row consumed (no longer pending)
turn completed 9s later
```

The queued row disappears from `queued_items` when the live session takes it up,
so that table holds *undelivered* messages only. Anyone probing this should
assume a queue into a live session **runs a turn on the account's behalf**, and
write probe text that forbids tool use rather than merely asking to be ignored.

**Multi-line prose survives the transport intact**, verified by reading the
destination's `userMessage` item and finding every newline preserved. This
depends on how the CLI is spawned: npm's Windows shim is `codex.cmd`, which Node
will not spawn without `shell: true`, and a shell would put the message body
through `cmd.exe` quoting. The shim itself runs `node <pkg>/bin/codex.js`, so
spawning that JS directly with an argv array keeps the message away from any
shell parser. A relay that shells out instead will corrupt exactly the payloads
4.1 says the MCP face exists to protect.

### 3.6 Why discovery reads the registry rather than calling `ListAgents`

Measured 2026-08-23 while building Unit 1, from cwd `D:\DevTools\AI-Tools`.

An earlier claim that `ListAgents` is workspace-scoped was **investigated and
retracted**. It is not: a call from `D:\DevTools\AI-Tools` returned three peers
all sitting in `D:\UnrealProjects\5.6\OperationPhoenix`, which was every other
entry in the registry at that moment. The original observation was a single
negative taken seconds before the absent session had registered.

What `ListAgents` actually lacks, each verified against live output:

- **No `cwd` field at all**, so it cannot answer "which sessions share my
  workspace" — which is exactly what scope filtering (4.2) needs.
- **No Codex threads.** It sees one of the two agent kinds.
- **No `pid`, `sessionId` or `messagingSocketPath`.**
- **Only coarse relative time** ("started 1d ago"), which is `startedAt`. The
  registry's `statusUpdatedAt` is what `idleFor` needs, and it is a different
  quantity: a session started 23h ago may have gone idle 40 seconds ago.

Reading `~/.claude/sessions/*.json` directly is therefore strictly more capable.

**`ListAgents` output is volatile across calls**, and so is the registry behind
it. Within one hour of this session, two named peers exited and a third
appeared; the Codex lock directory turns over faster still (3.3). Two
consequences: acceptance evidence must assert shape and properties rather than
exact target counts, and **a target can vanish between `list` and `send`** —
see section 6.

**Do not treat a stale `updatedAt` as a liveness signal.** Two registry entries
were stale by over an hour while both sessions were live, idle and messageable.
Idle sessions stop updating; that is the expected shape, not evidence of death.

## 4. Architecture

### 4.1 Location and shape

`D:/DevTools/AI-Tools/MCP-Servers/bridges/relay/`, matching the existing bridge
convention exactly: Node ESM, `client.mjs` (core), `server.mjs` (MCP face),
`*.test.mjs`, `package.json`, `manifest.json`.

One core module, two faces:

- **CLI face** - mandatory. It is the hand-debugging path and the escape hatch
  when the MCP server is not loaded in a given session.
- **MCP face** - a thin wrapper over the same core. Required on the Codex side
  because it is the sandbox crossing (3.4), and preferred on both sides because
  message payloads are multi-line prose that shell quoting corrupts.

### 4.2 Discovery layer

Shared by every command. Produces a normalized target record:

```
{ id, name, kind: "claude"|"codex", status, idleFor, cwd, turns,
  addressable, reason }
```

`addressable` and `reason` are explicit rather than derived from `turns`,
because the two kinds derive addressability differently and `turns` cannot carry
the meaning for both. A Codex thread is unaddressable at `turns: 0` (3.5); a
Claude session is unaddressable when its registry entry has no
`messagingSocketPath`, and its turn count is not in the registry at all. Turn
count is therefore `null` for Claude — reporting `0` there would borrow the
Codex meaning and be wrong.

`idleFor` is milliseconds in the current status and is `null` while a target is
busy. `turns` is `null` when unknown, distinct from `0`.

- Claude targets: read `~/.claude/sessions/*.json`.
- Codex targets: live threads from `~/.codex/thread-writer-locks/*.lock`,
  enriched from `thread_turns` and `session_meta`, filtered to
  `thread_source == "user"`.

Default scope is the caller's **workspace tree**, not the caller's exact `cwd`.
`--scope all` widens deliberately.

The original wording here said "the caller's `cwd`", which was underspecified
and produced a real bug in Unit 1: implemented as path equality, `list` reported
"no agent sessions in scope" from any subdirectory of a session's own root —
including the caller's own session, seen from the folder they were working in.
Nobody types commands from their repo root.

The rule is: a target is in scope when either normalized path is an ancestor of
the other, compared at a path-segment boundary. That covers both directions — a
session rooted above the caller, and a session rooted in a subfolder while the
caller stands at the root. Segment anchoring is required, or `D:\Work\Alpha`
matches the unrelated `D:\Work\AlphaBeta`.

Running from a drive root matches broadly; that is defensible and `--scope all`
exists for the deliberate case, so it is not worth guarding against.

### 4.3 Outbound transports

| Direction | Mechanism |
|---|---|
| Claude -> Claude | `SendMessage` (in-session tool) |
| Claude -> Codex | `codex queue` |
| Codex -> Codex | `codex queue` |
| Codex -> Claude | `claude -p` delegate, section 4.4 |

### 4.4 The Claude delivery delegate

Codex cannot call `SendMessage` and will not speak the peer pipe. Instead the
relay MCP server spawns a sanctioned client from its unsandboxed context:

```
claude -p --allowedTools SendMessage
```

with the prompt on **stdin**. Measured at 14s end to end, and it wakes idle
targets (3.2).

Two implementation notes:

- `--allowedTools` is variadic and will swallow a positional prompt. Pass the
  prompt on stdin, never as a trailing argument.
- **Variadic also means a test must check the whole run, not the next element.**
  Measured while building Unit 3: an assertion that `args[i + 1] === "SendMessage"`
  passes unchanged for `--allowedTools SendMessage Bash`, because the element
  after the flag is still `SendMessage`. A green confinement test proved nothing
  until it collected every argument up to the next `--flag` and compared the
  list.
- **The relayed text must be delimited by a per-invocation nonce**, and a message
  containing that delimiter refused rather than relayed. Otherwise a caller
  closes the payload early and appends instructions of their own, leaving the
  system prompt as the only thing between them and a laundered action. A fixed
  delimiter is forgeable by anyone who has seen one prompt.
- The delegate gets an `--append-system-prompt` confining it to relaying the
  message verbatim and using no tool other than `SendMessage`. Without this the
  delegate is a permission-laundering path: a Codex agent denied an action could
  emit a Claude prompt asking a peer to perform it. This is the same boundary
  the `SendMessage` contract enforces between peers, and it must hold here.

**The delegate destroys sender identity, and the relay is one-way because of
it.** Measured 2026-08-23, and confirmed at a receiving session:

A `claude -p` spawn registers as an ordinary session under a name derived from
whatever cwd it ran in — observed as `lib-c1`, `lib-9a`, `relay-32` — and exits
within seconds. Three consequences, in severity order:

1. **Replies are impossible.** `SendMessage`'s contract is to reply by copying
   the `from` attribute, and that address is dead on arrival every time. A Codex
   agent that asks a Claude session a question through the relay can never
   receive the answer. Reply routing is not solved here; it is a real design
   question and probably belongs with the deferred handoff system.
2. **Attribution is unverifiable.** The recipient sees the delegate's ephemeral
   name. Any claim about the true origin lives in the message body, which is the
   part a caller controls — and the relay cannot authenticate its own caller
   either, so it cannot do better than pass a claim along.
3. The delegate's name leaks the directory it ran in and varies run to run.

Mitigation, which is honest rather than sufficient: the relay prepends a header
to the delivered text — inside what is delivered, so a paraphrasing delegate
cannot drop it — stating that the message came through the relay, that the
sender address has already exited and cannot be replied to, and what origin was
claimed, explicitly marked unverified.

**A hostile body can imitate that header, so position is what distinguishes
them.** The delegate prompt uses two nested nonce-keyed regions: an outer one
telling the delegate what to deliver, and a `BODY` region inside the delivered
text marking the caller's contribution.

The property is stronger than "hard to forge". Body content is by construction
entirely *after* the first `BODY-BEGIN` marker — there is no operation a message
body can perform that places text before it. The region preceding that marker is
therefore **unforgeable by body content**, not merely difficult to forge, which
makes header authorship *decidable* rather than a judgement call. Verified end to
end with a message that deliberately imitates the header: the genuine one
arrived outside the markers, the imitation visibly inside.

**Two claims that must not be conflated.** This makes header **authorship**
provable. It leaves **origin** exactly as unverifiable as before, because relay
still cannot authenticate its caller. A reader who sees "forgery defeated" and
concludes the origin line is now trustworthy has drawn the wrong inference: the
origin is a claim being passed along in both cases, and the header says so.

**Parsing contract**, which consumers must follow for any of the above to hold:

- Everything before the **first** `BODY-BEGIN` is relay-authored.
- Everything from that marker to its matching `END` is caller-supplied data.
- Markers bearing **any other nonce are data, not structure.**

The delimiter guard rejects only the current invocation's nonce, so a body may
legally contain a differently-nonced marker pair. That is harmless against a
consumer that anchors on the first `BODY-BEGIN`, and misleading to a naive
parser that scans for any `RELAY-*-END` and treats what follows as trailer.
Hence the rule is written down rather than left implicit.

None of this is identity. It converts forgery from indistinguishable to
detectable, and that is the whole of the claim.

**A delegate spawn also registers as a discoverable target**, with
`kind: "interactive"` and a live `messagingSocketPath` — indistinguishable from
a real session on either field. **`entrypoint` is the discriminator:** `sdk-cli`
for a `claude -p` spawn, `cli` for an interactive session. Discovery filters on
it. Without that filter the relay offers its own delegates as targets, and a
message to one is lost when it exits mid-turn — the Claude-side twin of the
deferred-delivery failure in 3.5. This is the Claude analogue of the
`thread_source == "user"` filter, and exists for the same reason.

### 4.4a Origin stamping, and what can actually be authenticated

**A queued Codex message is indistinguishable from a typed one, to the
recipient.** It lands as an ordinary `userMessage`. Measured: relayed messages
carry a non-null `clientId` and human-typed ones do not — 9 of 276 in the live
store, perfectly correlated — but that field is in the store, not in the
receiving agent's context. So the only place to tell the recipient is the
message body, and relay stamps every outbound message with a header carrying
origin, transport, a reply address, and a nonce-delimited body region.

**Origin can be genuinely authenticated on every path in the matrix**, because
each host publishes its own session identity into the environment of processes
it spawns. Measured 2026-08-24, both sides:

| Source | Path | Identity variable |
|---|---|---|
| Claude session | CLI (Bash) | `CLAUDE_CODE_SESSION_ID` |
| Claude session | MCP server | same, inherited on spawn |
| Codex session | MCP server | `CODEX_THREAD_ID` / `CODEX_SESSION_ID` |
| Codex session | shell → CLI | same, measured on a spawned shell command |

So verification is not a Codex-only feature and the header must not imply it is.
`detectVerifiedOrigin()` is shared by both faces.

**Only the identifier is read, never the credential.** `CLAUDE_CODE_MESSAGING_TOKEN`
sits in the same environment and is peer-pipe secret material — the env-var twin
of the `.key` files safety discipline 4 forbids. The lookup is an explicit
allow-list of three variable names rather than a scan or a prefix match, and a
test asserts the token name is never even accessed. An environment read is the
easiest place to breach that discipline by accident; it was in fact breached once
during this investigation, by printing the variable while probing.

**Provider and transport are separate facts and are stated separately.** Which
variable is set tells relay which provider the sender runs on, and that holds
even when the sender's session does not resolve in discovery — so the provider
is reported from the environment, not inferred from a discovered target.

This matters because the two can differ: a **Claude** session sending through
**codex queue** produces `Transport: codex queue`, and if that were the only
provider word in the header a recipient would reasonably read the sender as
Codex. Before this, an unresolved sender rendered as `From: <id> (session)` with
no provider at all. It now renders `From: <id> (claude)` regardless of whether
discovery can see the session.

**The verified value is an id; the reply address is a name.** `SendMessage` takes
a session name, so echoing a verified Claude session id back as the reply
address would hand the recipient something unsendable. The verified id is
resolved through discovery and the header carries the resolved `name`. Verified
end to end: `2ed73e8c-…` → `ai-tools-dd`.

Codex-side detail:

```
CODEX_SESSION_ID=01a0355c-c86d-7c82-a767-669e1a06af2d
CODEX_THREAD_ID=01a0355c-c86d-7c82-a767-669e1a06af2d
```

Codex sets both in the environment of processes it spawns, and the MCP server is
spawned **per session** — confirmed independently by process ancestry, where the
relay server's parent is `codex.exe resume <thread-id>`. An agent cannot set the
environment of the server process it is talking to, so a value read there
identifies the calling session in a way a `from` argument never can. The server
reads it once at startup and passes it as `verifiedOrigin`; it is never accepted
from a tool argument.

Precedence and honesty rules:

- A verified origin **wins** over any claim.
- A claim that **disagrees** with it is surfaced in the header rather than
  dropped — disagreement is a confused caller or a spoof, and hiding it hides
  both.
- With no verified origin the header falls back to the claim, explicitly marked
  unauthenticated.

**The limit that matters, and it survives perfect authentication.** Verifying
the caller establishes *which session made the call*. It does not establish *who
authored the text*: an agent may be faithfully relaying something a human told
it, or something it read on a web page. Authentication bounds provenance of the
call, never authorship of the content — and an authenticated-looking header
invites exactly that over-reading, which is why the header says so in as many
words.

Process ancestry was the first route found and is the weaker one: the parent's
command line carries the thread id only for `resume`-launched sessions, is stale
if a TUI switches threads (the same trap that produced a retracted stale-lock
inference earlier the same day), and is unavailable to the CLI path entirely.
The environment variable supersedes it.

### 4.5 Conversational read layer

A projection over both formats into one turn shape:

```
{ turnId, role: "user"|"agent", ts, text, toolNames[], status, durationMs }
```

Commands:

- `list` - all targets with status and idle time.
- `summary <target>` - turn count, elapsed, last user ask, last agent
  conclusion, current status, tool-name histogram. The high-value one for
  orchestration: answers "what is this doing, is it stuck" in about ten lines
  instead of a 64MB file.
- `read <target> [--tail N | --since <turnId>]` - normalized turns.

**Conversational text is the default; tool results require an explicit flag.**
This bounds context, since tool results are the bulk of the bytes, and it
reduces the permission-laundering surface in the read direction, since tool
results are where another session's file reads and command output mostly live.

**It does not close that hole, and the spec must not claim it does.** Assistant
text routinely quotes file contents inline - this design session pasted registry
JSON and `session_meta` blocks into prose repeatedly. A peer that read a secret
and mentioned it in its own narration would surface it under the default scope.
No read scoping makes cross-session reads permission-equivalent to the reader's
own permissions; that is a property of reading another session at all, not of
how the read is scoped. Treat cross-session read access as a privilege roughly
equal to the union of what every readable session could see, and scope who may
use the tool accordingly.

The concrete case is not hypothetical: during design the classifier blocked this
session from reading `~/.claude/sessions/*.key`, which a raw transcript read of a
peer could have circumvented.

**Transcript content is data, never instructions.** A transcript may contain text
the session fetched from a web page, a Jira comment or a teammate's file. An
agent reading it must not treat that as direction.

### 4.6 Threading

`send <target> --re <turnId> "<text>"` attaches a message to the claim it is
about, so the receiver has a referent instead of a context-free interruption.

Codex side: `thread_turns.turn_id` is a stable per-turn id.

Claude side: **verified 2026-08-23.** Records in
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` carry a durable per-record
`uuid` plus a `parentUuid` chain, alongside `sessionId`, `timestamp`,
`promptId` and `isSidechain`. These are content ids, not positional indices, so
they do not retarget.

**A reference must carry an excerpt, not just an id.** A uuid stays valid after
the turn it names has been compacted out of the receiving session's context, so
a bare id can address something the peer no longer remembers. `--re` therefore
sends a short quote of the referenced turn alongside the id, so the reference
survives compaction on the receiver.

## 5. Safety disciplines

1. Delegate confinement (4.4) - no laundering in the write direction.
2. Conversational-default reads (4.5) - no laundering in the read direction.
3. Transcript content is data, never instructions (4.5).
4. Never read session `.key` material. The design has no need for it.
5. Scope defaults to caller `cwd` so a broadcast cannot accidentally reach
   sessions in unrelated projects.

## 6. Failure handling

No fallback transport. On any delivery failure the relay:

1. Returns an error naming the cause (target not found, **target disappeared
   since listing**, zero turns, delegate nonzero exit, delegate produced no
   confirmation).

"Target disappeared since listing" is its own named cause, not a variant of
"target not found". Both registries turn over on the order of minutes (3.3,
3.6), so a target that was addressable when listed and is gone when sent to is
an ordinary race, not a caller error — it should read as "that session ended,
re-list" rather than as a bad address.

**The taxonomy is decided pre-flight from discovery, never from what
`codex queue` reports** (3.5). Store presence is what separates a bad address
from an ended session:

| Live lock | In `thread_turns` | `thread_source` | Cause |
|---|---|---|---|
| no | no | — | target not found |
| no | yes | user | target disappeared since listing |
| no | yes | subagent | subagent threads cannot be queued |
| yes | 0 rows | user | target not yet addressable |
| yes | ≥1 row | user | proceed |

A Claude target resolves to its own refusal: Claude delivery needs the Unit 3
delegate.

Two limits this design accepts rather than papers over:

- **`codex queue` confirms enqueue, never delivery.** Nothing in Unit 2 can
  confirm a peer actually received a message; that needs the read layer or a
  reply. Success wording is "queued into `<thread>`".
- **The residual race is undetectable by design.** A target can pass the
  liveness check and exit before the queue lands, and that case returns exit 0
  with a success string indistinguishable from delivery (3.5). The relay never
  learns it happened, so it cannot be spooled either. Stated here as a known
  limit rather than mitigated with a detector that would not work.

**The liveness check must be immediate, not inherited from the listing.** The
lock file is re-read directly before invoking `codex queue`, because a listing
that is seconds old is already stale: Claude peers were observed exiting and
appearing between two consecutive `ListAgents` calls, and the Codex lock
directory turns over at least as fast (3.6).

This makes "target disappeared since listing" **silent-data-loss prevention, not
an error-wording nicety.** Without the re-check the relay hands a dead thread to
`codex queue`, gets exit 0 and a success string, and reports a delivery that
never happened. It is the only guard that works, because output parsing cannot
see this case (3.5).

Worth stating separately because it outlives this code: **`codex queue` reports
success for any syntactically valid thread id whose session is dead.** Anyone
invoking it directly is exposed to this, not just the relay.
2. Writes the message to a spool file so nothing is lost.

The spool is **human-readable and never agent-drained**. The moment an agent
drains it, it becomes a second delivery path and reintroduces every failure mode
section 2 rejected it for.

## 7. Open risks

- **Cross-session read privilege** (4.5) - reading a peer's transcript is
  roughly equivalent to holding the union of what every readable session could
  see, and no read scoping changes that. The highest-severity property in this
  design. Scope who may use `read` accordingly.
- **Delegate nondeterminism** - the delivery path contains a model call, so it
  could in principle do something other than relay. Mitigated by
  `--allowedTools SendMessage`, the confining system prompt, and requiring a
  confirmation token in output before reporting success. Observed correct on
  first attempt in testing.
- **Schema drift** - both stores are internal to their vendors. Contained by
  reading only a small stable subset (role, text, timestamp, tool names, turn
  id). On drift, `summary` degrades; nothing corrupts.
- **Codex dual-store transition** - rollout JSONL and the sqlite thread store
  coexist. Prefer sqlite; treat rollout as fallback for older threads.
- **Daemon config caching** - measured 2026-08-23 (3.4): the shared app-server
  daemon caches sandbox state, and a config change did not take effect until
  restart. Never treat a sandbox result as evidence without first confirming
  the setting under test is actually live.

## 8. Sequencing

Units sized to reach behavioral feedback, per the workspace's
demonstration-sized-work-unit rule.

- **Unit 1** - discovery + `list`, both agent kinds, cwd scoping. Proves the
  registry reads against live sessions. **Delivered 2026-08-23** as
  `MCP-Servers/bridges/relay/` (`client.mjs`, `cli.mjs`, `client.test.mjs`),
  44 tests, no runtime dependencies. `node:sqlite` is treated as an optional
  capability: without it the Codex half degrades to rollout-only — id, cwd,
  `thread_source` and addressability survive, turn counts and timing do not — so
  the bridge still runs on the Node 18 baseline the other bridges declare.
- **Unit 2** - outbound `send` to **Codex targets only**, via `codex queue`.
  Plus spool-on-failure and the delivery-failure taxonomy (section 6).

  Corrected 2026-08-23: this unit originally also claimed Claude -> Claude, on
  the reasoning that it needs no delegate. That is not buildable as scoped.
  `SendMessage` is an **in-session tool, not a shell-invocable command** — from
  inside a Claude session an agent calls it directly and the relay contributes
  nothing but discovery, and from a CLI it cannot be called at all. Every
  shell-invocable path to a Claude target therefore requires the
  `claude -p --allowedTools SendMessage` delegate, which is Unit 3. **All
  Claude-targeted delivery moves to Unit 3.** `send` names a Claude target as a
  refusal with that reason, rather than attempting anything.

  Claude -> Codex and Codex -> Codex are one mechanism, not two code paths:
  both are `codex queue --thread <id> --message <text>`.

  **Delivered 2026-08-23.** `send` in `client.mjs`, `send.test.mjs`, CLI face in
  `cli.mjs`. 72 tests. Acceptance included a real multi-line delivery into a live
  Codex thread verified at the destination — turn count advanced, queue row
  consumed, newlines intact, target replied "Acknowledged." and ran no tools.
- **Unit 3** - MCP face over the Unit 1-2 core, registered in both `.mcp.json`
  and Codex `config.toml`, **including the `claude -p` delegate**. Codex -> Claude
  lands here and not earlier: the delegate needs an unsandboxed
  Codex-reachable context, and the MCP server is that context (3.4). The 14s
  measurement behind it was taken from a Claude Bash tool, not from Codex, so
  Unit 3's acceptance criterion is a delegate spawn observed from a real Codex
  session.
- **Unit 4** - `summary`, then `read`. Retires the manual byte-seeking
  technique.
- **Unit 5** - `--re` threading with excerpt-carrying references (4.6).
  **Delivered 2026-08-24.** `resolveReference()` in `client.mjs`,
  `reference.test.mjs`, `--re` on the CLI.

  The excerpt rule is enforced rather than documented: a reference that cannot
  be resolved to a quote **fails the send** under its own cause
  (`reference_unresolved`) rather than degrading to a bare id. A dangling
  reference is worse than none — it asserts a shared referent that does not
  exist and the recipient cannot tell which — and silently dropping it would
  turn a threaded reply back into the context-free interruption threading exists
  to prevent. Referencing a Claude target is refused for the same reason: the
  Unit 4 read layer covers Codex only, so relay cannot quote the turn.

  The reference and its quote render **outside** the body markers, since they are
  relay-authored quotation of the recipient's own earlier words; inside the body
  region they would be indistinguishable from the sender's new text.

Units 1-3 deliver the requested capability. Units 4-5 deliver the conversational
model on top of it.

## 9. Verification discipline

Three failures during this build were the same class, and none of them was a
failing test. Each was **an instrument reporting success without having tested
anything** — the suite lying in the reassuring direction, which is the direction
nobody investigates. A red test gets read; a green one does not.

1. **An assertion that read the wrong position and passed regardless.**
   `args[i + 1] === "SendMessage"` is satisfied by
   `--allowedTools SendMessage Bash`, because `--allowedTools` is variadic. The
   confinement test was green while the delegate held a shell.
2. **An assertion that reduced to something trivially true.** Chained `indexOf`
   arithmetic that, read back, could not fail for any input.
3. **A mutation that never applied.** Both authors hit this within the same few
   minutes, each producing a "0 tests failed" result from a probe that had not
   run. One traced the cause: a Bash heredoc halved the backslashes in the match
   string, so it never matched a line that was sitting there unchanged. **The
   other never established the cause** — the match string was expected to match
   by the author's own reading, did not, and was resolved by rewriting it to
   contain no escapes at all.

   That asymmetry is the more useful half, and the reason this is not written as
   a tidy symmetric anecdote: the guard works even when you never find out what
   went wrong, which is the common case. Requiring the mutation to prove it
   applied costs nothing and does not depend on understanding the failure.

Three guards caught them, in increasing cost. Run them in this order, because
the cheapest catches the most common:

1. **Read the assertion back and ask what would have to be true for it to
   fail.** Catches the trivially-true assertion, costs nothing, and should come
   before any tooling.
2. **Assert the mutation target exists before mutating.** A mutation that cannot
   silently fail to apply is worth more than one that returns a clean bill of
   health because it never ran.
3. **Require a NAMED test to die, not a count.** "Three tests failed" is
   satisfied by three unrelated tests; "these three, by name" is not. This is
   what caught the variadic hole, and it is the only one of the three that
   distinguishes a guard that works from a guard that merely exists.

Applied to a security boundary, guard 3 is not optional: a green test around
confinement is not evidence until it has been watched going red for the right
reason. Two people mutating independently and comparing the *names* of the dead
tests is stronger still — it is how the variadic hole surfaced, since the author
who mutated the code never questioned the assertion.

Guards 1-3 all catch an instrument reporting a false **success**. A fourth
catches the mirror image, which happened twice in this build:

4. **Before calling a conclusion measured, name the instrument and what it
   ranges over.** An inference is not a measurement, and labelling one
   "decisive" does not make it one. Worked example from this build: "7 locks but
   only 3 Codex processes, therefore 4 locks are stale" compares a count of
   *processes* against a count of *threads*, on the unchecked assumption that a
   process's command line names the thread it is currently on. It does not — a
   TUI switches threads after launch. Once that assumption fails the two numbers
   range over different populations and the comparison is not weak evidence, it
   is not evidence. The lock-handle probe run beside it passes the same test and
   its negative result stands.

   The same check applies to numbers quoted from elsewhere, and the worked
   example is the threshold in section 6. Four figures circulated in support of
   it. Exactly **one** measures wake latency. One is a poll-limited upper bound
   whose start time was never recorded. Two are not latencies at all — a turn
   `duration_ms` and a Claude-side idle→busy→idle interval.

   Establishing that took four passes between two authors, and three of the four
   were corrections **to a correction**: one author propagated the set without
   decomposing it, the other decomposed three and miscounted which, the first
   verified that and found the fourth. Guard 4 works, but slowly, and only
   because each pass went back to the artifact.

   **The numbers that survive longest unchallenged are the ones cheap to quote
   and expensive to verify.** A measurement repeated between two agents is not
   corroborated, only propagated — during this very exchange a `duration_ms` was
   copied from one turn row onto another in a message whose subject was number
   propagation.

   A false **finding** costs as much as a false green and is quieter, because a
   finding gets acted on rather than investigated. It sends people to fix what
   is not broken.

One last thing, learned by doing the opposite. Establishing that threshold took
five exchanges of corrections-to-corrections between two authors. Every
individual correction was right, and the chain was collectively wasteful anyway:
**a sequence of individually-correct refinements can still be worth stopping,
and the signal is not that any step is wrong — none were — but that the thing
under refinement stopped being load-bearing several steps back.** The threshold
was margin rather than measurement from the first pass. Everything after that
polished a number that was never going to be precise, while the one action
actually blocking the unit went untouched throughout.

The behaviour that actually caught both near-misses is worth stating on its own,
because it is not "reason carefully": **probe the thing even when you already
believe you know the answer.** The race was caught by probing anyway after the
first check looked conclusive; the unsound inference was caught by probing
instead of shipping it. Neither was caught by thinking harder about it.
