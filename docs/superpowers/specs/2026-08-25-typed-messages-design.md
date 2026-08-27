# Typed Messages and Conversation Correlation — Design

Date: 2026-08-25
Status: Delivered 2026-08-27. Measured outcomes in section 12; two
predictions in this document were overturned by measurement and are corrected
there rather than edited away.
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

- `v` — schema version. Present from the first release so a later change is
  detectable rather than ambiguous.
- `kind` — `request` | `reply` | `notice`. Default `notice`.
- `conversation` — see section 5.
- `message_id` — minted by relay per message, so a reply can name what it
  answers. Caller-supplied values are ignored: a caller that could choose its
  own message ids could make an unrelated message look like an answer.
- `in_reply_to` — the `message_id` being answered, or null.
- `from` — the existing verified-origin work, restated in machine form:
  `verified: true` only when read from the host's own environment. When
  `verified` is false, `id` carries whatever the caller **claimed**, or null if
  it claimed nothing — never a fabricated value, and never silently promoted.
  The field is only as good as the flag beside it, and a reader that ignores the
  flag is reading a claim as a fact.

The prose header stays. A human reading a Codex thread should not have to parse
JSON, and an agent should not have to parse prose.

**Both must be generated from one source.** The `from` object restates what the
prose origin line already says, and two renderings of the same fact drift: a
change to one is a silent contradiction in the other, and a reader has no way to
tell which is stale. They are built from a single resolved value, not written
twice.

**Both transports carry the header.** It is added by the envelope builder, which
already serves the direct queue and the delegate alike, so a message is typed
regardless of which way it travelled. A header present on one path and absent on
the other would make correlation depend on the recipient's provider, which is
exactly the asymmetry the verified-origin work removed.

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

Any relay instance can then report one of four verdicts with **no stored
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

### The reply flow depends on the recipient being able to send

Stated because it is the difference between this design working and being
write-only, and it is not currently true in both directions:

| Recipient | Can it reply today? |
|---|---|
| Claude session | **Yes.** The relay MCP face is registered top-level as of 2026-08-25, so any newly started Claude session has `relay_send`. |
| Codex session | **Yes, as of 2026-08-26.** This row read "No, refused under the host's approval policy" until the policy question was settled. See section 12. |

This does not change the design — the header is what a reply needs, whenever
replying becomes possible — but it does mean **rung 1 delivers a half-duplex
result on the Codex side until that is settled**. Building it is still worth
doing: the correlation is useful on messages a Codex session receives even
before it can answer them, and a Codex recipient can still answer out of band.
But "request/reply works" should not be claimed for Codex recipients on the
strength of this spec alone; it needs the approval question closed and then
demonstrated.

### `in_reply_to` versus the existing `--re`

Both exist and are different:

- `--re <turnId>` — *about that thing you said*. References the recipient's own
  transcript, carries an excerpt so the reference survives compaction, requires
  a read.
- `in_reply_to <messageId>` — *this answers that message*. References a relay
  message, and is free because relay minted the id.

## 7. API surface

Stated explicitly, because the reply recipe above shows flags without ever
defining them and an implementer would otherwise be inferring the contract from
an example.

**`relay_send` gains three optional parameters**, on both faces:

| MCP | CLI | Meaning |
|---|---|---|
| `conversation` | `--conversation` | continue this conversation; minted if absent |
| `kind` | `--kind` | `request` \| `reply` \| `notice`; defaults to `notice` |
| `in_reply_to` | `--in-reply-to` | the `message_id` this answers |

`message_id` is **not** a parameter — relay mints it, for the reason in section 4.

**Nothing is added to the receive side.** With no stored state, relay does not
track, index, or act on an incoming conversation: it computes the attestation
verdict, writes it into the header, and delivers. A recipient that wants to
follow a conversation reads the header. This is worth saying plainly because
"conversation" normally implies a server keeping track, and here nothing does.

**Why `conversation` earns a place in rung 1**, given `in_reply_to` alone
correlates a single answer with a single question: multi-turn exchanges. Two
questions and two answers chain pairwise through `in_reply_to`, but a recipient
asking "am I already engaged with this session on this topic?" would have to walk
the chain. One field answers it. It is also what rungs 2–3 attach to, but it
would earn its place here regardless.

## 8. Behaviour at the edges

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

## 9. Testing

Following what has worked in this bridge:

- Unit tests on the header builder: field presence, defaults, versioning.
- Unit tests on each of the **four** attestation verdicts, including the
  reply-case verdict that must *not* read as an error, and the two absences that
  must not be collapsed into each other.
- A **mutation test** that moving the meta block inside the body markers fails —
  the positional-forgery property is what keeps a sender from forging a header,
  and a green test around it is not evidence until it has been watched going
  red.
- A **forged-header test**, which is a different thing from the mutation test
  above and is the one that covers the actual attack: a message whose *body*
  contains a well-formed `RELAY-META` line claiming another conversation and a
  different sender. The parser must read the relay-written header and ignore the
  planted one. Emitting in the right place and refusing to read the wrong place
  are two properties, and only the second stops a forgery.
- Round-trip: mint, reply, and confirm the conversation and `in_reply_to`
  correlate.
- One live exchange between two real sessions, output read rather than merely
  confirmed to have run.

## 10. One integration requirement, found by checking

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

## 11. Compatibility

An unadorned send still works exactly as today and carries `kind: notice`. No
existing caller changes. Recipients that ignore `RELAY-META` see the prose header
they already saw.

## 12. Measured outcomes, 2026-08-27

Recorded after implementation, and kept separate from the design above so a
reader can see which claims were predictions and which were measured.

**A Codex session can reply, overturning section 6.** That table said no,
because `relay_send` was refused under the host's approval policy. The refusal
was real and its text was `MCP tool call requires approval, but approval policy
is never`. Under the granular policy since configured, a Codex session called
`relay_list` and `relay_send` successfully and the message arrived. No daemon
restart was needed; the policy applied to an already-running session.

**Origin is verified on the Codex path, which section 4 assumed it could not
be.** The relay design's 4.4a carried a table row claiming Codex publishes a
thread id into the environment of the servers it spawns. It does not. It
publishes one in the metadata of every tool call, which is better — per call
rather than read once, so it cannot go stale. Measured live: a Codex session
received `{"verified":true,"id":"01a04376-...","provider":"codex","source":
"metadata the host attached to this call"}`. The correction is in 4.4a of the
relay design; identity now resolves per call at both faces.

**The reply recipe renders per face.** Section 6 shows one form using command
line flags for both. The implementation renders the tool form with named
parameters and the command line form with flags, because that line exists to be
pasted and one rendering would be wrong for one of them:

```
To reply: relay_send with to="ai-tools-dd", conversation="c-4b2c9f1a@...", in_reply_to="m-6f21a0", kind="reply"
          (CLI: relay send ai-tools-dd --message "..." --conversation c-4b2c9f1a@... --in-reply-to m-6f21a0 --kind reply).
```

**The loop is closed, observed 2026-08-27.** A Codex session sent to a Claude
session through the confined delegate; the message arrived with a verified Codex
origin, an intact header and intact body markers, so the header survived the one
hop that contains a model. The Claude session replied into the originating
thread through `codex queue` and the reply landed. Both directions in one motion.

**That round trip immediately found a bug no unit test had.** The envelope told
its Claude recipient *"Conversation ... opened by you"* about a conversation the
Codex sender had opened. The verdict was computed in the sender's process from
the sender's identity and then read by the recipient: correct for whoever wrote
the line, wrong for everyone who reads it. The envelope now takes the recipient
and compares against that, and names the conversation without a verdict when no
reader is known.

Worth recording why the tests missed it. Every one was written from the sender's
side, where passing the sender's identity is the obvious thing to do, and the
test named *the conversation verdict appears in the prose for a human reader*
asserted `opened by someone-else` and passed while the shipped message told its
actual reader the opposite. It checked the string and not the perspective. The
class is general: code correct in the frame where it is written and wrong in the
frame where it is consumed, which is what serialisation boundaries are made of.

The fix was then verified the same way rather than by more sender-side tests.
Three lines sit in the recipient's own store: the pre-fix reply telling the
Codex thread *"you are 2ed73e8c"*, which is the Claude id; the post-fix message
reading *"opened by you"* to the session that did open it; and the Codex agent's
own answer confirming the line was true from its side.

**Volume caps were built and removed the same day.** They are recorded as a
non-goal in section 2 of the relay design, with the reasoning, so they are not
rebuilt from the argument that was already wrong once.
