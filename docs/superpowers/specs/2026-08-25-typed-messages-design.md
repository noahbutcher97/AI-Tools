# Typed Messages and Conversation Correlation — Design

Date: 2026-08-25
Status: Design approved in conversation; spec pending Noah review
Depends on: `2026-08-23-cross-agent-relay-design.md` (Units 1–5, delivered)

## 1. Purpose

Give relayed messages a machine-readable shape, so a receiving agent can tell a
question from a notice, correlate an answer with what it answers, and reply
without a human transcribing addresses.

This is **rung 1 of four**. The capability Noah described decomposes into a
ladder, each rung adding exactly one thing:

| Rung | Adds | New machinery |
|---|---|---|
| **1. Request/reply** | correlation and intent | typed header, conversation id |
| 2. Long-running delegation | continuity across a restart | durable conversation record, **re-binding** |
| 3. Multi-agent coordination | more than two parties | membership, fan-out |
| 4. Durable handoff | delivery to a session that does not exist yet | stored messages |

Rung 1 is specified here. Rungs 2–3 are deliberately left buildable on top
rather than designed now. **Rung 4 is out of scope on purpose**: it requires the
durable inbox that the relay design rejected in its section 2, for reasons that
still hold — duplicate delivery, reordering, racing drains, ambiguous
addressing. Reaching it means reopening that decision deliberately, with its own
acceptance semantics, not arriving at it by accretion.

## 2. Non-goals

- **No durable conversation record.** Nothing is written to disk.
- **No re-binding.** A conversation does not survive a participant restarting
  under a new session id. That is rung 2, and its hard part — deciding that a
  new session continues a dead one — is a correctness problem, not a storage
  one: guess wrong and a conversation is delivered to the wrong agent.
- **No membership or fan-out.** Two parties only.
- **No enforcement of `kind`.** Relay conveys intent; it does not police whether
  a `request` is answered.

## 3. Constraint that shapes everything

**The transport carries no metadata.** `codex queue` takes a string and
`SendMessage` takes a string. There is no header channel, no envelope the
protocol understands. Therefore *typed* necessarily means **a machine-readable
block riding inside the message body**, and every property below has to survive
being text a recipient reads.

This also means the existing positional-forgery guarantee is what protects it:
anything outside the nonce-delimited body markers is relay-written, and a sender
cannot place text there.

## 4. The typed header

One line, versioned, emitted before the existing prose header and outside the
body markers:

```
RELAY-META {"v":1,"kind":"request","conversation":"c-4b2c9f1a@01a034fa-7e07-7c71-a58f-4d49569c1636",
            "message_id":"m-6f21a0","in_reply_to":null,
            "from":{"id":"2ed73e8c-…","provider":"claude","verified":true}}
```

**Wrapped above for readability; emitted as a single physical line.** This is not
cosmetic. A recipient parses by finding the line beginning `RELAY-META ` and
JSON-parsing the remainder, so a header split across lines would not parse. The
line is therefore emitted unwrapped however long it gets.

### Parsing contract

The same rule the body markers already follow, stated for the header because
omitting it is how a forgery gets in:

- A `RELAY-META` line is authoritative **only before the first `BODY-BEGIN`
  marker**. That region is relay-written and a sender cannot place text there.
- A `RELAY-META` line appearing **inside** the body region is sender-supplied
  data. It is not structure, and a parser that scans the whole message for the
  first `RELAY-META` can be fed a forged one.
- **Take the first occurrence before the first `BODY-BEGIN`, and no other.**

### Unknown versions

A recipient seeing a `v` it does not know should read the prose header and treat
the message as an ordinary relayed note, not discard it. The prose header is
always present precisely so an unrecognised schema degrades to something a human
or an older agent can still act on.

- `v` — schema version. Present from the first release so a later change is
  detectable rather than ambiguous.
- `kind` — `request` | `reply` | `notice`. Default `notice`.
- `conversation` — see section 5.
- `message_id` — minted by relay per message, so a reply can name what it
  answers. Caller-supplied values are ignored: a caller that could choose its
  own message ids could make an unrelated message look like an answer.
- `in_reply_to` — the `message_id` being answered, or null.
- `from` — the existing verified-origin work, restated in machine form:
  `verified: true` only when read from the host's own environment.

The prose header stays. A human reading a Codex thread should not have to parse
JSON, and an agent should not have to parse prose.

## 5. Conversation identity, and what attestation actually proves

A conversation id **encodes the verified origin of the session that opened it**.
The exact form matters, because verified origins are uuids and therefore contain
dashes — a dash-delimited encoding could not be parsed back apart unambiguously:

```
c-4b2c9f1a@01a034fa-7e07-7c71-a58f-4d49569c1636
  │  │       └─ the full verified origin that minted it
  │  └─ 8 random hex, so two conversations from one session differ
  └─ fixed prefix

c-4b2c9f1a          ← no "@" part: minted with no verified origin
```

Split on the **first** `@`. Neither uuids nor Claude session names contain one,
so the boundary is unambiguous and the origin is stored whole rather than
truncated — a truncated origin would have to be prefix-matched, which invites
collisions between sessions sharing a prefix.

This was chosen over relay remembering ids it minted. In-memory state gives a
worse guarantee than it appears to: it is lost on every restart — and Codex
sessions restart constantly — and it is available from the long-lived MCP server
but not from the per-invocation CLI, so the same command would carry a different
guarantee depending on which face ran it. Encoding costs nothing, behaves
identically from both faces, and survives restarts.

Any relay instance can then report one of three verdicts with **no stored
state**, by comparing the encoded origin against the sender's own verified
origin:

| Verdict | Condition |
|---|---|
| `opened by you` | sender's verified origin matches the encoded one |
| `opened by <id>, you are <other>` | both known and different — the ordinary reply case, not an error |
| `opened by an unverified sender` | the id carries no `@` part, whether or not this sender is verified |
| `claimed, unverifiable` | this sender has no verified origin, whatever the id encodes |

The third and fourth rows are distinct and were nearly collapsed. They describe
opposite absences: one is a conversation that was *opened* without proof, the
other is a sender who cannot prove who they are *now*. A reply from a verified
session into an unverifiably-opened conversation is the third, not the fourth,
and reporting it as the fourth would understate what is known.

**What this proves and does not prove.** It proves continuity of the *minting
party*. It does not prove the integrity of the conversation: anyone who has seen
the id can quote it. That is a higher bar than inventing one — you must have
been a participant or read the transcript — but it is not authentication, and
the header says so in the same terms the origin line already uses.

## 6. Reply flow

With no stored state, the header must carry everything a reply needs. The reply
recipe becomes fully formed:

```
To reply: relay_send to "ai-tools-dd"
            --conversation c-4b2c9f1a@01a034fa-7e07-7c71-a58f-4d49569c1636
            --in-reply-to  m-6f21a0
```

The recipient sends that back; relay sees the conversation id encodes A's origin
while the sender's is B's, and stamps *opened by ai-tools-dd, you are 01a034fa*.
The round trip closes with nothing written down anywhere.

### `in_reply_to` versus the existing `--re`

Both exist and are different:

- `--re <turnId>` — *about that thing you said*. References the recipient's own
  transcript, carries an excerpt so the reference survives compaction, requires
  a read.
- `in_reply_to <messageId>` — *this answers that message*. References a relay
  message, and is free because relay minted the id.

## 7. Behaviour at the edges

Each has a defined answer, so none of them is discovered in production:

- **Sender has no verified origin** — the conversation is still minted, and
  reported `claimed, unverifiable`. Absence of proof is stated, not fatal.
- **`kind: reply` with no `in_reply_to`** — allowed. The header notes the reply
  has no referent rather than rejecting a message that is otherwise fine.
- **`kind: reply` with no `conversation`** — relay would otherwise mint a fresh
  one, silently starting a new thread while the message says it continues an old
  one. The header states that the reply opened a new conversation instead,
  because a correlation that quietly points at the wrong thread is worse than
  one that is visibly absent.
- **Both `--re` and `in_reply_to` supplied** — coherent and allowed. They answer
  different questions: which message this responds to, and which of the
  recipient's own turns it is about. Neither implies the other.
- **A conversation id that does not parse** — treated as an opaque claimed id.
  Never a crash, never a rejection.
- **Encoded origin differs from the sender** — the *normal* reply case. It must
  not be rendered as a warning; doing so would make every successful reply look
  suspicious.
- **An unknown `kind`** — rejected at the CLI and MCP boundary, where the caller
  can still fix it, rather than being stamped into a message.

## 8. Testing

Following what has worked in this bridge:

- Unit tests on the header builder: field presence, defaults, versioning.
- Unit tests on each of the three attestation verdicts, including the
  reply-case verdict that must *not* read as an error.
- A **mutation test** that moving the meta block inside the body markers fails —
  the positional-forgery property is what keeps a sender from forging a header,
  and a green test around it is not evidence until it has been watched going
  red.
- Round-trip: mint, reply, and confirm the conversation and `in_reply_to`
  correlate.
- One live exchange between two real sessions, output read rather than merely
  confirmed to have run.

## 9. One integration requirement, found by checking

The Claude delegate relays text through a **model**, instructed to keep
"everything else byte for byte — including the BODY marker lines". The meta line
would survive on that general clause alone, but the instruction names the BODY
markers specifically, and a specific list reads as exhaustive to a model
deciding what matters. A dropped meta line would fail silently: delivery would
succeed and the correlation would simply be gone.

**The delegate instruction must name the `RELAY-META` line explicitly**, and a
test must assert it survives a delegate round trip rather than only a direct
queue. This is the one place where a header that works everywhere else can be
lost, because it is the one path with a model between the sender and the
recipient.

## 10. Compatibility

An unadorned send still works exactly as today and carries `kind: notice`. No
existing caller changes. Recipients that ignore `RELAY-META` see the prose header
they already saw.
