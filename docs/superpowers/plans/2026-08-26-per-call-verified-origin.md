# Per-Call Verified Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve sender identity per call from whichever channel the host offers, so a message relayed from Codex arrives with a verified origin and a working reply address, and bound the reply loops that become possible once it does.

**Architecture:** Three values threaded separately through the send path (`verifiedOrigin`, `verifiedProvider`, and the new host metadata) collapse into one `identity` object resolved once per call. Two resolvers feed it: the existing environment read, which serves the CLI and Claude's MCP face, and a new request-metadata read for Codex's MCP face. A ledger file in the temp directory caps how many messages one conversation may carry.

**Tech Stack:** Node 18+ ESM (`.mjs`), `node:test`, `node:fs`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-cross-agent-relay-design.md` — sections 4.4a, 4.4b, 4.4c and 4.7. Read those four before starting; this plan argues from them and does not restate their reasoning.

## Global Constraints

- **Node 18 baseline.** No syntax or API newer than Node 18. `node:sqlite` is an optional capability only, never required.
- **No new runtime dependencies.** The bridge has none and keeps none.
- **Run tests from the bridge directory**, `MCP-Servers/bridges/relay/`. Running `node --test` at the repo root picks up unrelated suites and reports meaningless totals.
- **Never write file content containing backslashes through a bash heredoc.** Heredocs halve them silently, which has corrupted fixtures and mutation probes in this repo more than once. Use the Write or Edit tool for any such content.
- **Never read, log, or store `CLAUDE_CODE_MESSAGING_TOKEN`** or session `.key` material. Safety discipline 4. The environment read is an explicit allow-list of three variable names, never a prefix scan.
- **A mutation test must name the test it expects to kill.** "Three tests failed" is satisfied by three unrelated tests. Assert the target string exists before substituting, or the probe can silently fail to apply.
- **Identity is never accepted from a tool argument**, under any circumstance, on any path.

---

## File Structure

| File | Responsibility |
|---|---|
| `MCP-Servers/bridges/relay/identity.mjs` | **New.** Resolving caller identity and filtering host metadata. Pure functions, no I/O. Separated from `client.mjs` because that file is already ~1700 lines and this is a self-contained concern with its own security properties. |
| `MCP-Servers/bridges/relay/ledger.mjs` | **New.** The exchange-volume ledger: path, append, count, prune. Pure except for file I/O, which is confined here. |
| `MCP-Servers/bridges/relay/client.mjs` | Modified. Consumes an `identity` object instead of two loose parameters; enforces the caps. |
| `MCP-Servers/bridges/relay/server.mjs` | Modified. Resolves identity per call from the MCP request. |
| `MCP-Servers/bridges/relay/cli.mjs` | Modified. Resolves identity from the environment, as today, through the new shape. |
| `MCP-Servers/bridges/relay/identity.test.mjs` | **New.** Tests for resolution and filtering. |
| `MCP-Servers/bridges/relay/ledger.test.mjs` | **New.** Tests for the caps. |
| `MCP-Servers/bridges/relay/origin.test.mjs` | Modified. Existing origin tests move to the new shape. |
| `MCP-Servers/bridges/relay/meta.test.mjs` | Modified. The deep equality on `from` gains the new fields. |

---

### Task 1: Resolve identity from request metadata

**Files:**
- Create: `MCP-Servers/bridges/relay/identity.mjs`
- Create: `MCP-Servers/bridges/relay/identity.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `detectRequestOrigin(extra)` returns `{ id, provider, channel, host }` or `null`. `channel` is the string `"request-metadata"`. `host` is the raw turn-metadata object, unfiltered — Task 2 filters it.
  - `CODEX_META_KEY` — the string `"x-codex-turn-metadata"`.

- [ ] **Step 1: Write the failing tests**

Create `identity.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { CODEX_META_KEY, detectRequestOrigin } from "./identity.mjs";

// A capture from a real Codex tool call, 2026-08-26. Point-in-time: it cannot
// detect Codex changing this shape in the field, which is why unknown keys are
// also recorded to the spool at run time (spec 4.4c).
const REAL_META = {
  progressToken: 1,
  callId: "exec-ffc92b78-4ba4-494a-90e0-22f9d03f7df2",
  [CODEX_META_KEY]: {
    session_id: "01a03ec6-68fb-70d0-b582-114e8e0c2440",
    thread_id: "01a03ec6-68fb-70d0-b582-114e8e0c2440",
    turn_id: "01a03ecb-b93a-7b12-9322-ce8955e516fd",
    thread_source: "user",
    model: "gpt-5.6-terra",
    reasoning_effort: "high",
  },
  threadId: "01a03ec6-68fb-70d0-b582-114e8e0c2440",
};

test("the thread id is read from the namespaced turn metadata", () => {
  const identity = detectRequestOrigin({ _meta: REAL_META });

  assert.equal(identity.id, "01a03ec6-68fb-70d0-b582-114e8e0c2440");
  assert.equal(identity.provider, "codex");
  assert.equal(identity.channel, "request-metadata");
});

test("the top-level threadId is a fallback, not the primary source", () => {
  // Both carried the same value when measured. If they ever diverge the
  // namespaced one is authoritative, because it is the structured field.
  const meta = { [CODEX_META_KEY]: { thread_id: "from-namespace" }, threadId: "from-toplevel" };

  assert.equal(detectRequestOrigin({ _meta: meta }).id, "from-namespace");
});

test("the fallback is used when the namespace carries no thread id", () => {
  assert.equal(detectRequestOrigin({ _meta: { threadId: "only-here" } }).id, "only-here");
});

test("provider comes from the namespace key, never from a value inside it", () => {
  // Spec 4.4a. A value naming a provider is caller-adjacent data; the key is
  // the part relay recognises.
  const meta = { [CODEX_META_KEY]: { thread_id: "t1", provider: "claude" } };

  assert.equal(detectRequestOrigin({ _meta: meta }).provider, "codex");
});

test("an unrecognised metadata namespace yields no identity", () => {
  // The namespace is allow-listed even though fields inside it are not. A host
  // inventing another key gets no trust at all (spec 4.4b).
  const meta = { "x-someotherhost-turn-metadata": { thread_id: "t1" } };

  assert.equal(detectRequestOrigin({ _meta: meta }), null);
});

test("metadata carrying no identity key is treated exactly as metadata absent", () => {
  assert.equal(detectRequestOrigin({ _meta: { progressToken: 1 } }), null);
});

test("absent and malformed metadata both yield null rather than throwing", () => {
  // A shape this design did not author must not be able to crash a send.
  assert.equal(detectRequestOrigin(undefined), null);
  assert.equal(detectRequestOrigin({}), null);
  assert.equal(detectRequestOrigin({ _meta: null }), null);
  assert.equal(detectRequestOrigin({ _meta: "not-an-object" }), null);
  assert.equal(detectRequestOrigin({ _meta: { [CODEX_META_KEY]: "not-an-object" } }), null);
  assert.equal(detectRequestOrigin({ _meta: { [CODEX_META_KEY]: { thread_id: 42 } } }), null);
});

test("the raw turn metadata is carried through for filtering", () => {
  // Task 2 filters it. This function does not, so that filtering has one home.
  const identity = detectRequestOrigin({ _meta: REAL_META });

  assert.equal(identity.host.model, "gpt-5.6-terra");
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: FAIL — `Cannot find module './identity.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

Create `identity.mjs`:

```js
// Resolving who is calling relay, from whichever channel the host offers.
//
// Spec 4.4a. Two channels exist and neither is universal: Claude publishes a
// session id into the environment of servers it spawns, Codex publishes a
// thread id in the metadata of every request. Both are written by the host and
// not by the calling agent, which is what makes either usable as identity.

// The namespace key is ALLOW-LISTED even though the fields inside it are not.
// A host inventing a different key gets no trust and yields no origin, which is
// the safe default and what makes the deny-list inside acceptable (spec 4.4b).
export const CODEX_META_KEY = "x-codex-turn-metadata";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function detectRequestOrigin(extra) {
  if (!isObject(extra) || !isObject(extra._meta)) return null;
  const meta = extra._meta;
  const turn = isObject(meta[CODEX_META_KEY]) ? meta[CODEX_META_KEY] : null;

  // The namespaced field is authoritative; the top-level one is a fallback.
  // Both carried the same value when measured 2026-08-26.
  const id =
    (turn && typeof turn.thread_id === "string" && turn.thread_id) ||
    (typeof meta.threadId === "string" && meta.threadId) ||
    null;
  if (!id) return null;

  return { id, provider: "codex", channel: "request-metadata", host: turn || {} };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-check the namespace allow-list**

Temporarily change `meta[CODEX_META_KEY]` to scan for any key ending `-turn-metadata`. Confirm the string you are replacing exists before replacing it, then run the suite.

Expected to die by name: `an unrecognised metadata namespace yields no identity`.

Revert the mutation.

- [ ] **Step 6: Commit**

```bash
git add MCP-Servers/bridges/relay/identity.mjs MCP-Servers/bridges/relay/identity.test.mjs
git commit -m "relay: read caller identity from Codex request metadata"
```

---

### Task 2: Filter the host metadata container

**Files:**
- Modify: `MCP-Servers/bridges/relay/identity.mjs`
- Modify: `MCP-Servers/bridges/relay/identity.test.mjs`

**Interfaces:**
- Consumes: `CODEX_META_KEY` from Task 1.
- Produces:
  - `buildHostMetadata(raw)` returns `{ kept, dropped, overflow }` where `kept` is an object of surviving scalars, `dropped` is a sorted array of denied or non-scalar key names, and `overflow` is a boolean.
  - `HOST_META_DENY` — array of lowercase substrings.
  - `HOST_META_MAX_BYTES` — the number `2048`.

- [ ] **Step 1: Write the failing tests**

Append to `identity.test.mjs`:

```js
import { HOST_META_MAX_BYTES, buildHostMetadata } from "./identity.mjs";

test("scalars are carried", () => {
  const out = buildHostMetadata({ model: "gpt-5.6-terra", turns: 3, fast: true });

  assert.deepEqual(out.kept, { model: "gpt-5.6-terra", turns: 3, fast: true });
});

test("an object value is dropped while scalar siblings survive", () => {
  // Two assertions on purpose. A test that only checks the survivors passes
  // when nothing is filtered at all (spec 4.4c).
  const out = buildHostMetadata({ model: "gpt-5.6-terra", context: { auth_token: "SECRET" } });

  assert.deepEqual(out.kept, { model: "gpt-5.6-terra" });
  assert.equal(out.dropped.includes("context"), true);
});

test("an array value is dropped", () => {
  const out = buildHostMetadata({ model: "m", tags: ["a", "b"] });

  assert.equal("tags" in out.kept, false);
});

test("a credential-named key is dropped however it is spelled", () => {
  const out = buildHostMetadata({
    apiKey: "x", access_token: "x", AUTH: "x", "bearer-value": "x", model: "m",
  });

  assert.deepEqual(out.kept, { model: "m" });
  assert.equal(out.dropped.length, 4);
});

test("session_id is dropped because the identity it duplicates is carried elsewhere", () => {
  // Intended, not incidental: `session` is on the deny-list and the id is
  // already `from.id` (spec 4.4b).
  const out = buildHostMetadata({ session_id: "s1", thread_id: "t1" });

  assert.equal("session_id" in out.kept, false);
  assert.equal(out.kept.thread_id, "t1");
});

test("an oversized blob is carried as nothing, and says so", () => {
  // Not a truncation, which would produce invalid JSON, and not a silent
  // subset, which no recipient could detect (spec 4.4b).
  const out = buildHostMetadata({ big: "x".repeat(HOST_META_MAX_BYTES + 1) });

  assert.deepEqual(out.kept, {});
  assert.equal(out.overflow, true);
});

test("a blob under the cap does not report overflow", () => {
  assert.equal(buildHostMetadata({ model: "m" }).overflow, false);
});

test("a null or malformed input yields an empty result rather than throwing", () => {
  assert.deepEqual(buildHostMetadata(null).kept, {});
  assert.deepEqual(buildHostMetadata("nope").kept, {});
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: FAIL — `buildHostMetadata is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `identity.mjs`:

```js
// Names are unconstrained; shape and size are not (spec 4.4b). Passing unknown
// NAMES through is the point. Passing unknown SHAPES through is not: a deny-list
// matching key names cannot see a credential nested under an innocuous parent.
export const HOST_META_DENY = [
  "token", "secret", "password", "passwd", "apikey", "key", "auth",
  "credential", "bearer", "cookie", "session", "jwt", "signature", "sig", "private",
];

// The header is prepended to every relayed message and travels the delegate
// path inside a spawned prompt, so an unbounded blob is a per-send cost. The
// measured blob is roughly 300 bytes; this is headroom, not a squeeze.
export const HOST_META_MAX_BYTES = 2048;

function isDenied(name) {
  const flat = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return HOST_META_DENY.some((needle) => flat.includes(needle));
}

export function buildHostMetadata(raw) {
  const kept = {};
  const dropped = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kept, dropped, overflow: false };
  }

  for (const [name, value] of Object.entries(raw)) {
    const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    if (!scalar || isDenied(name)) {
      dropped.push(name);
      continue;
    }
    kept[name] = value;
  }
  dropped.sort();

  // Applied after filtering, so a dropped credential cannot push the blob over
  // the cap and take the legitimate fields with it.
  if (Buffer.byteLength(JSON.stringify(kept), "utf8") > HOST_META_MAX_BYTES) {
    return { kept: {}, dropped, overflow: true };
  }
  return { kept, dropped, overflow: false };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: PASS, 16 tests.

- [ ] **Step 5: Mutation-check the shape filter**

Temporarily delete `!scalar ||` from the condition so only the deny-list filters. Run the suite.

Expected to die by name: `an object value is dropped while scalar siblings survive` and `an array value is dropped`.

Revert.

- [ ] **Step 6: Commit**

```bash
git add MCP-Servers/bridges/relay/identity.mjs MCP-Servers/bridges/relay/identity.test.mjs
git commit -m "relay: constrain the shape and size of carried host metadata"
```

---

### Task 3: One identity object, resolved per call

**Files:**
- Modify: `MCP-Servers/bridges/relay/identity.mjs`
- Modify: `MCP-Servers/bridges/relay/identity.test.mjs`

**Interfaces:**
- Consumes: `detectRequestOrigin` from Task 1.
- Produces: `resolveCallerIdentity({ env, extra })` returns an identity object `{ id, provider, channel, host }` or `null`. Callers pass `env` for the environment channel and `extra` for the request channel; either may be omitted.

- [ ] **Step 1: Write the failing tests**

Append to `identity.test.mjs`:

```js
import { resolveCallerIdentity } from "./identity.mjs";

const CODEX_EXTRA = { _meta: { [CODEX_META_KEY]: { thread_id: "codex-1", model: "m" } } };

test("the environment channel serves a Claude-spawned server", () => {
  const identity = resolveCallerIdentity({ env: { CLAUDE_CODE_SESSION_ID: "claude-1" } });

  assert.equal(identity.id, "claude-1");
  assert.equal(identity.provider, "claude");
  assert.equal(identity.channel, "environment");
});

test("the request channel serves a Codex-spawned server", () => {
  const identity = resolveCallerIdentity({ env: {}, extra: CODEX_EXTRA });

  assert.equal(identity.id, "codex-1");
  assert.equal(identity.channel, "request-metadata");
});

test("neither channel yields null, not a null-filled object", () => {
  // Matches detectVerifiedOrigin and the optional-chaining idiom at both call
  // sites (spec 4.4a).
  assert.equal(resolveCallerIdentity({ env: {} }), null);
});

test("agreeing channels report the per-call one", () => {
  const identity = resolveCallerIdentity({ env: { CODEX_THREAD_ID: "codex-1" }, extra: CODEX_EXTRA });

  assert.equal(identity.id, "codex-1");
  assert.equal(identity.channel, "request-metadata");
});

test("disagreeing channels yield no identity at all", () => {
  // Fail-closed. An earlier draft let the fresher value win, which hands an
  // override to an adversary able to influence one channel but not the other
  // (spec 4.4a). Two channels that should never both speak, contradicting each
  // other, is the worst moment to stamp VERIFIED on either.
  const identity = resolveCallerIdentity({ env: { CODEX_THREAD_ID: "other" }, extra: CODEX_EXTRA });

  assert.equal(identity, null);
});

test("the messaging token is never read, on any path", () => {
  // Safety discipline 4. The environment lookup is an explicit allow-list of
  // three names, never a scan.
  const seen = [];
  const env = new Proxy(
    { CLAUDE_CODE_SESSION_ID: "s1", CLAUDE_CODE_MESSAGING_TOKEN: "SECRET" },
    { get(target, name) { seen.push(String(name)); return target[name]; } },
  );

  resolveCallerIdentity({ env, extra: null });

  assert.equal(seen.includes("CLAUDE_CODE_MESSAGING_TOKEN"), false, "relay touched the messaging token");
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: FAIL — `resolveCallerIdentity is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `identity.mjs`:

```js
// An explicit allow-list, never a prefix scan: CLAUDE_CODE_MESSAGING_TOKEN sits
// in this same namespace and is pipe-secret material (safety discipline 4).
const IDENTITY_VARS = [
  ["CODEX_THREAD_ID", "codex"],
  ["CODEX_SESSION_ID", "codex"],
  ["CLAUDE_CODE_SESSION_ID", "claude"],
];

function fromEnvironment(env) {
  for (const [name, provider] of IDENTITY_VARS) {
    const value = env ? env[name] : undefined;
    if (value) return { id: value, provider, channel: "environment", host: {} };
  }
  return null;
}

export function resolveCallerIdentity({ env = process.env, extra = null } = {}) {
  const fromRequest = detectRequestOrigin(extra);
  const fromEnv = fromEnvironment(env);

  // The two are not expected to co-occur: a Codex-spawned server has no
  // identity in its environment, a Claude-spawned one receives no Codex turn
  // metadata. Agreement reports the per-call channel; DISAGREEMENT claims
  // nothing (spec 4.4a).
  if (fromRequest && fromEnv && fromRequest.id !== fromEnv.id) return null;
  return fromRequest || fromEnv;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: PASS, 22 tests.

- [ ] **Step 5: Mutation-check the fail-closed rule**

Temporarily replace the disagreement line with `if (fromRequest && fromEnv && fromRequest.id !== fromEnv.id) return fromRequest;` — the rule this design rejected. Run the suite.

Expected to die by name: `disagreeing channels yield no identity at all`.

Revert.

- [ ] **Step 6: Commit**

```bash
git add MCP-Servers/bridges/relay/identity.mjs MCP-Servers/bridges/relay/identity.test.mjs
git commit -m "relay: resolve caller identity per call, failing closed on channel disagreement"
```

---

### Task 4: Thread the identity object through the send path

This is the task that closes the delegate bug. `buildDelegateInvocation` accepts `verifiedOrigin` and never accepted `verifiedProvider`, so a verified Codex sender renders as `(session)` rather than `(codex)` on the one path Codex actually uses — in a function whose own comment promises the two transports cannot drift apart.

**Files:**
- Modify: `MCP-Servers/bridges/relay/client.mjs` — `buildRelayEnvelope`, `buildDelegateInvocation`, `relayViaDelegate`, `sendMessage`
- Modify: `MCP-Servers/bridges/relay/origin.test.mjs`

**Interfaces:**
- Consumes: the identity object from Task 3.
- Produces: `buildRelayEnvelope({ message, origin, originTarget, identity, reference, transport, nonce })`, `buildDelegateInvocation({ targetName, message, origin, originTarget, identity, nonce, command })`, and `sendMessage({ ..., identity, ... })`. The parameters `verifiedOrigin` and `verifiedProvider` are removed from all three.

- [ ] **Step 1: Write the failing tests**

Append to `origin.test.mjs`:

```js
import { buildDelegateInvocation } from "./client.mjs";

const CODEX_IDENTITY = { id: "codex-1", provider: "codex", channel: "request-metadata", host: { model: "m" } };
const CLAUDE_IDENTITY = { id: "claude-1", provider: "claude", channel: "environment", host: {} };

test("the delegate path reports the sender's provider", () => {
  // The bug this task closes: buildDelegateInvocation never accepted a
  // provider, so a verified Codex sender rendered as "(session)" on the one
  // path Codex actually uses.
  const invocation = buildDelegateInvocation({
    targetName: "some-target",
    message: "hello",
    identity: CODEX_IDENTITY,
  });

  assert.match(invocation.stdin, /\(codex\)/);
  assert.doesNotMatch(invocation.stdin, /\(session\)/);
});

test("the envelope names the environment channel for a Claude sender", () => {
  const { text } = buildRelayEnvelope({ message: "hi", identity: CLAUDE_IDENTITY });

  assert.match(text, /the host's own session environment/);
});

test("the envelope names the request channel for a Codex sender", () => {
  // Reporting "environment" for a metadata read would be a true statement about
  // verification wrapped around a false one about provenance (spec 4.4a).
  const { text } = buildRelayEnvelope({ message: "hi", identity: CODEX_IDENTITY });

  assert.match(text, /metadata the host attached to this call/);
  assert.doesNotMatch(text, /session environment/);
});

test("a Codex sender gets a usable reply address", () => {
  // A Codex target's name is its thread id, so the existing resolution works
  // once an id exists to resolve (spec 4.4c).
  const { text } = buildRelayEnvelope({ message: "hi", identity: CODEX_IDENTITY });

  assert.match(text, /To reply: relay_send to "codex-1"/);
});

test("no identity still renders the unverified wording", () => {
  const { text } = buildRelayEnvelope({ message: "hi", identity: null, origin: "i-say-im-bob" });

  assert.match(text, /NOT authenticated by relay/);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test origin.test.mjs`
Expected: FAIL — the envelope renders `(session)` and the channel phrases are absent.

- [ ] **Step 3: Change the three signatures**

In `client.mjs`, replace the `verifiedOrigin` and `verifiedProvider` parameters of `buildRelayEnvelope` with a single `identity = null`, and delete the now-stale comment above them — it claims Codex sets `CODEX_THREAD_ID` in the environment of processes it spawns, which was measured false on 2026-08-26.

```js
export function buildRelayEnvelope({
  message,
  origin = null,
  originTarget = null,
  // Resolved per call by the calling face from a host channel the caller
  // cannot write (spec 4.4a). One object rather than three parallel
  // parameters, because three values that must always travel together are one
  // value, and threading them separately is what let the delegate path drop
  // the provider.
  identity = null,
  reference = null,
  transport = "codex-queue",
  nonce = randomUUID(),
} = {}) {
```

Inside, replace the origin block's opening:

```js
  if (identity?.id) {
    const where = originTarget?.cwd ? `, ${originTarget.cwd}` : "";
    const kind = originTarget?.kind ? `${originTarget.kind}${where}` : identity.provider || "session";
    const replyTo = originTarget?.name || identity.id;
    const source =
      identity.channel === "request-metadata"
        ? "metadata the host attached to this call"
        : "the host's own session environment";
    lines.push(
      `From: ${identity.id} (${kind}) — VERIFIED. Relay read this from ${source}, not from anything the sender supplied, so it identifies the calling session rather than asserting who wrote the text.`,
    );
    if (origin && origin !== identity.id) {
```

Replace the remaining `verifiedOrigin` references in that block with `identity.id`.

- [ ] **Step 4: Carry the identity through the delegate path**

In `buildDelegateInvocation`, replace `verifiedOrigin = null` with `identity = null` and pass `identity` into the `buildRelayEnvelope` call. In `relayViaDelegate`, replace the `verifiedOrigin` parameter with `identity` and forward it. In `sendMessage`, replace both parameters with `identity = null`, forward it to `relayViaDelegate` and `buildRelayEnvelope`, and change `resolveOrigin(verifiedOrigin || origin, targets)` to `resolveOrigin(identity?.id || origin, targets)`.

- [ ] **Step 5: Run the whole suite**

Run: `cd MCP-Servers/bridges/relay && node --test`
Expected: PASS. Existing tests that passed `verifiedOrigin`/`verifiedProvider` must be updated to pass `identity` — this is a deliberate breaking change to an internal interface, so update call sites rather than adding a compatibility shim.

- [ ] **Step 6: Mutation-check the delegate provider**

Temporarily delete `identity` from the object passed to `buildRelayEnvelope` inside `buildDelegateInvocation` — reproducing the original bug. Run the suite.

Expected to die by name: `the delegate path reports the sender's provider`.

Revert. That the original bug shipped with a green suite is why this probe exists.

- [ ] **Step 7: Commit**

```bash
git add MCP-Servers/bridges/relay/client.mjs MCP-Servers/bridges/relay/origin.test.mjs
git commit -m "relay: carry one identity object through the send path"
```

---

### Task 5: Resolve identity at both faces

**Files:**
- Modify: `MCP-Servers/bridges/relay/server.mjs`
- Modify: `MCP-Servers/bridges/relay/cli.mjs`
- Modify: `MCP-Servers/bridges/relay/server.test.mjs`

**Interfaces:**
- Consumes: `resolveCallerIdentity` from Task 3, the `identity` parameter from Task 4.
- Produces: no new exports. The MCP face resolves per call; the CLI face resolves per invocation.

- [ ] **Step 1: Write the failing test**

Append to `server.test.mjs`:

```js
test("a counterfeit _meta in tool arguments does not influence identity", () => {
  // THE ATTACK. Measured against a live Codex session on 2026-08-26: a call
  // passing a forged x-codex-turn-metadata in its ARGUMENTS received the
  // genuine ids, because the client injects this metadata after the caller's
  // arguments.
  //
  // That probe used a tool with an EMPTY argument schema. relay_send declares
  // properties and additionalProperties: false, so the populated-schema case is
  // assumed rather than measured and is covered here (spec 4.4c).
  const args = { to: "x", message: "y", _meta: { "x-codex-turn-metadata": { thread_id: "FORGED" } } };
  const extra = { _meta: { "x-codex-turn-metadata": { thread_id: "GENUINE" } } };

  const identity = resolveCallerIdentity({ env: {}, extra });

  assert.equal(identity.id, "GENUINE");
  assert.equal(JSON.stringify(identity).includes("FORGED"), false);
  assert.equal("_meta" in args, true, "the forged argument was present to be ignored");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd MCP-Servers/bridges/relay && node --test server.test.mjs`
Expected: FAIL — `resolveCallerIdentity is not defined` until imported.

- [ ] **Step 3: Wire the MCP face**

In `server.mjs`, delete the `HOST_IDENTITY` constant and its comment block. Import `resolveCallerIdentity` from `./identity.mjs`. Change the `relay_send` handler to take a second parameter and resolve per call:

```js
  async ({ to, message, dry_run = false, from }, extra) => {
    const result = await sendMessage({
      to,
      message,
      dryRun: dry_run,
      allowDelegate: true,
      origin: from,
      // Resolved per call, never from a tool argument. `extra` carries the
      // request's own metadata; the arguments object is not consulted.
      identity: resolveCallerIdentity({ extra }),
      ...(process.env.RELAY_SPOOL ? { spoolPath: process.env.RELAY_SPOOL } : {}),
    });
    return toolJsonResult(result);
  },
```

- [ ] **Step 4: Wire the CLI face**

In `cli.mjs`, replace the `detectVerifiedOrigin` import with `resolveCallerIdentity` from `./identity.mjs`, replace `const hostIdentity = detectVerifiedOrigin();` with `const hostIdentity = resolveCallerIdentity();`, and replace the two `verifiedOrigin`/`verifiedProvider` options with `identity: hostIdentity`.

- [ ] **Step 5: Run the whole suite**

Run: `cd MCP-Servers/bridges/relay && node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add MCP-Servers/bridges/relay/server.mjs MCP-Servers/bridges/relay/cli.mjs MCP-Servers/bridges/relay/server.test.mjs
git commit -m "relay: resolve identity per call at the MCP face and per invocation at the CLI"
```

---

### Task 6: Carry channel, submitted_by and host in RELAY-META

**Files:**
- Modify: `MCP-Servers/bridges/relay/client.mjs` — `buildMetaLine`
- Modify: `MCP-Servers/bridges/relay/meta.test.mjs`

**Interfaces:**
- Consumes: `buildHostMetadata` from Task 2, the identity object from Task 3.
- Produces: `buildMetaLine({ kind, conversation, messageId, inReplyTo, from })` where `from` gains `channel`, `submitted_by` and `host`.

- [ ] **Step 1: Write the failing tests**

Append to `meta.test.mjs`:

```js
test("the sender object carries the channel it was verified through", () => {
  const meta = parse(buildMetaLine({ from: { id: "c1", provider: "codex", verified: true, channel: "request-metadata", host: { model: "m" } } }));

  assert.equal(meta.from.channel, "request-metadata");
  assert.deepEqual(meta.from.host, { model: "m" });
});

test("submitted_by is always agent, because relay only writes headers for tool calls", () => {
  // Resolves a contradiction: the prose says the message was not typed by a
  // human, while host.thread_source can read "user" — which describes how the
  // calling THREAD began, not who wrote this message (spec 4.4b).
  const meta = parse(buildMetaLine({ from: { id: "c1", provider: "codex", verified: true, host: { thread_source: "user" } } }));

  assert.equal(meta.from.submitted_by, "agent");
  assert.equal(meta.from.host.thread_source, "user");
});

test("a sender with no host metadata omits the field rather than sending an empty object", () => {
  const meta = parse(buildMetaLine({ from: { id: "s1", provider: "claude", verified: true } }));

  assert.equal("host" in meta.from, false);
});
```

Then update the existing `every field round-trips through JSON` test, whose deep equality on `from` now fails by design. Do not loosen it to a subset check: a deep equality on a security-relevant structure is what makes an unintended field addition visible (spec 4.4c).

```js
  assert.deepEqual(meta.from, {
    id: "2ed73e8c", provider: "claude", verified: true, submitted_by: "agent", channel: "environment",
  });
```

and pass `channel: "environment"` in that test's `from`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test meta.test.mjs`
Expected: FAIL — `channel` and `submitted_by` are undefined, and the round-trip deep equality mismatches.

- [ ] **Step 3: Implement**

In `buildMetaLine`, build the `from` object as:

```js
  const host = buildHostMetadata(from?.host).kept;
  const sender = {
    id: from?.id ?? null,
    provider: from?.provider ?? null,
    verified: Boolean(from?.verified),
    // Relay only ever writes a header for a message submitted through a tool
    // call. This says who made the CALL, not who composed the text — an agent
    // may be relaying words a human gave it (spec 4.4b).
    submitted_by: "agent",
    channel: from?.channel ?? null,
  };
  if (Object.keys(host).length > 0) sender.host = host;
```

- [ ] **Step 4: Run the whole suite**

Run: `cd MCP-Servers/bridges/relay && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add MCP-Servers/bridges/relay/client.mjs MCP-Servers/bridges/relay/meta.test.mjs
git commit -m "relay: carry channel, submitter and host metadata in the typed header"
```

---

### Task 7: The exchange-volume ledger

**Files:**
- Create: `MCP-Servers/bridges/relay/ledger.mjs`
- Create: `MCP-Servers/bridges/relay/ledger.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ledgerPath()` returns the absolute path, always under `os.tmpdir()`.
  - `recordSend(path, { now, conversation })` appends one line; returns `{ ok, error }`.
  - `checkCaps(path, { now, conversation })` returns `{ allowed, cause, detail }`.
  - `CONVERSATION_CAP` (20), `HOURLY_CAP` (200), `RETENTION_MS` (24 hours).

- [ ] **Step 1: Write the failing tests**

Create `ledger.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONVERSATION_CAP, HOURLY_CAP, checkCaps, ledgerPath, recordSend } from "./ledger.mjs";

function tempLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-ledger-")), "ledger.log");
}

test("the ledger lives in the temp directory, not under the user profile", () => {
  // Load-bearing (spec 4.7). A sandboxed Codex server cannot write under the
  // home directory, and a counter split across two files by provider would be
  // worse than none. TEMP and TMP are among the variables Codex does pass.
  assert.equal(ledgerPath().startsWith(os.tmpdir()), true);
});

test("a conversation under the cap is allowed", () => {
  const p = tempLedger();
  for (let i = 0; i < CONVERSATION_CAP - 1; i++) recordSend(p, { now: 1000 + i, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: 2000, conversation: "c-1" }).allowed, true);
});

test("a conversation at the cap is refused, naming the conversation and the remedy", () => {
  // The first thing in this design that can refuse a legitimate send, so the
  // error has to be actionable (spec 4.7).
  const p = tempLedger();
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(p, { now: 1000 + i, conversation: "c-1" });

  const verdict = checkCaps(p, { now: 2000, conversation: "c-1" });

  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /c-1/);
  assert.match(verdict.detail, /new conversation/i);
});

test("a different conversation is unaffected by another's cap", () => {
  const p = tempLedger();
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(p, { now: 1000 + i, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: 2000, conversation: "c-2" }).allowed, true);
});

test("a slow loop cannot reset itself by falling below the hourly window", () => {
  // Retention is 24h while the global window is 1h, so the conversation cap
  // counts every retained entry (spec 4.7).
  const p = tempLedger();
  const hour = 3_600_000;
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(p, { now: i * hour, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: CONVERSATION_CAP * hour, conversation: "c-1" }).allowed, false);
});

test("the hourly cap catches a fresh conversation minted per message", () => {
  const p = tempLedger();
  for (let i = 0; i < HOURLY_CAP; i++) recordSend(p, { now: 1000 + i, conversation: `c-${i}` });

  const verdict = checkCaps(p, { now: 2000, conversation: "c-new" });

  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /hour/i);
});

test("entries older than the retention window stop counting toward the hourly cap", () => {
  const p = tempLedger();
  const day = 86_400_000;
  for (let i = 0; i < HOURLY_CAP; i++) recordSend(p, { now: 1000 + i, conversation: `c-${i}` });

  assert.equal(checkCaps(p, { now: 1000 + day + 1, conversation: "c-new" }).allowed, true);
});

test("an unreadable ledger fails open and says so", () => {
  // Refusing every send because a counter file broke would cause the outage the
  // counter exists to prevent (spec 4.7).
  const verdict = checkCaps(path.join(os.tmpdir(), "relay-ledger-does-not-exist", "x.log"), { now: 1, conversation: "c-1" });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.inoperative, true);
});

test("a malformed line does not stop the ledger counting the rest", () => {
  const p = tempLedger();
  recordSend(p, { now: 1000, conversation: "c-1" });
  fs.appendFileSync(p, "not json\n");
  recordSend(p, { now: 1001, conversation: "c-1" });

  assert.equal(checkCaps(p, { now: 2000, conversation: "c-1" }).allowed, true);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test ledger.test.mjs`
Expected: FAIL — `Cannot find module './ledger.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `ledger.mjs`:

```js
// Bounding runaway exchanges (spec 4.7).
//
// Delivery wakes an idle session with no human input and every delivered
// message costs a model turn. Once the Codex direction gained a verified reply
// address, two agents could sustain an exchange indefinitely; the missing
// address had been suppressing that by accident.
//
// The threat is an ACCIDENTAL loop, not a malicious one. An adversary who can
// spawn processes already defeats the identity model entirely, so hardening
// these caps against one would cost legitimate use and buy nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONVERSATION_CAP = 20;
export const HOURLY_CAP = 200;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Always the temp directory, never the user profile. A sandboxed Codex server
// cannot write under the home directory; if this inherited the spool's
// fallback, the Codex side would count in one file and the Claude side in
// another, and a shared counter that is not shared is worse than none.
export function ledgerPath() {
  return path.join(os.tmpdir(), "cross-agent-relay-ledger.log");
}

// Appends are atomic at this size and counting is a read, so no lock protocol
// is needed. A race over-counts rather than under-counts, which errs toward
// refusing — the safe direction for a cost guard.
export function recordSend(ledger, { now, conversation }) {
  try {
    fs.appendFileSync(ledger, `${JSON.stringify({ t: now, c: conversation })}\n`);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error && error.message) };
  }
}

function readEntries(ledger, now) {
  const raw = fs.readFileSync(ledger, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.t === "number" && now - entry.t <= RETENTION_MS) entries.push(entry);
    } catch {
      // One corrupt line must not blind the counter to every other line.
    }
  }
  return entries;
}

export function checkCaps(ledger, { now, conversation }) {
  let entries;
  try {
    entries = readEntries(ledger, now);
  } catch {
    // Fails open, loudly. The caller reports the guard inoperative rather than
    // refusing every send over a broken counter file.
    return { allowed: true, inoperative: true, cause: null, detail: null };
  }

  if (conversation) {
    const inConversation = entries.filter((entry) => entry.c === conversation).length;
    if (inConversation >= CONVERSATION_CAP) {
      return {
        allowed: false,
        inoperative: false,
        cause: "exchange_capped",
        detail: `conversation ${conversation} has reached its ${CONVERSATION_CAP}-message cap. If this exchange is genuinely longer, open a new conversation deliberately rather than by accident.`,
      };
    }
  }

  const recent = entries.filter((entry) => now - entry.t <= HOUR_MS).length;
  if (recent >= HOURLY_CAP) {
    return {
      allowed: false,
      inoperative: false,
      cause: "exchange_capped",
      detail: `relay has sent ${recent} messages in the last hour, at the ${HOURLY_CAP}-per-hour machine-wide cap. Something is looping; check the spool before raising it.`,
    };
  }

  return { allowed: true, inoperative: false, cause: null, detail: null };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd MCP-Servers/bridges/relay && node --test ledger.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-check the retention rule**

Temporarily change the conversation filter to count only entries within `HOUR_MS`. Run the suite.

Expected to die by name: `a slow loop cannot reset itself by falling below the hourly window`.

Revert.

- [ ] **Step 6: Commit**

```bash
git add MCP-Servers/bridges/relay/ledger.mjs MCP-Servers/bridges/relay/ledger.test.mjs
git commit -m "relay: add the exchange-volume ledger"
```

---

### Task 8: Enforce the caps in the send path

**Files:**
- Modify: `MCP-Servers/bridges/relay/client.mjs` — `SEND_CAUSES`, `sendMessage`
- Modify: `MCP-Servers/bridges/relay/send.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-23-cross-agent-relay-design.md` — the cause list in section 6

**Interfaces:**
- Consumes: `checkCaps`, `recordSend`, `ledgerPath` from Task 7.
- Produces: `SEND_CAUSES.EXCHANGE_CAPPED` with the value `"exchange_capped"`.

- [ ] **Step 1: Write the failing tests**

Append to `send.test.mjs`:

```js
import { CONVERSATION_CAP, recordSend } from "./ledger.mjs";

function tempLedgerPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cap-")), "ledger.log");
}

test("a send past the conversation cap is refused and spooled", needsStore, async () => {
  const home = codexHome();
  liveThread(home);
  const h = harness(home);
  const ledger = tempLedgerPath();
  for (let i = 0; i < CONVERSATION_CAP; i++) recordSend(ledger, { now: 1000 + i, conversation: "c-loop" });

  const result = await sendMessage({
    to: THREAD, message: MESSAGE, ledgerPath: ledger, conversation: "c-loop", ...h.options,
  });

  assert.equal(result.ok, false);
  assert.equal(result.cause, SEND_CAUSES.EXCHANGE_CAPPED);
  assert.equal(typeof result.spooled, "string");
  assert.equal(h.calls.length, 0, "a capped send must not reach the transport");
});

test("a successful send is recorded, so the next one counts it", needsStore, async () => {
  // Two assertions, not one: a test that only checks the send succeeded stays
  // green if recording is deleted entirely.
  const home = codexHome();
  liveThread(home);
  const h = harness(home);
  const ledger = tempLedgerPath();

  const result = await sendMessage({
    to: THREAD, message: MESSAGE, ledgerPath: ledger, conversation: "c-1", ...h.options,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(ledger, "utf8").includes("c-1"), true);
});

test("a dry run is neither capped nor recorded", needsStore, async () => {
  // A dry run delivers nothing, so it costs no turn and must not consume quota.
  const home = codexHome();
  liveThread(home);
  const h = harness(home);
  const ledger = tempLedgerPath();

  await sendMessage({
    to: THREAD, message: MESSAGE, dryRun: true, ledgerPath: ledger, conversation: "c-1", ...h.options,
  });

  assert.equal(fs.existsSync(ledger), false);
});

test("an unreadable ledger lets the send through and spools that the guard is off", needsStore, async () => {
  // Fails open, loudly. Two assertions: one that the send survived, one that
  // the failure was announced. A test checking only the first passes when the
  // announcement is deleted, leaving a cost guard that is silently off.
  const home = codexHome();
  liveThread(home);
  const h = harness(home);
  const spoolFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-spool-")), "spool.log");
  const unreadable = path.join(os.tmpdir(), "relay-ledger-missing-dir", "ledger.log");

  const result = await sendMessage({
    to: THREAD, message: MESSAGE, ledgerPath: unreadable, conversation: "c-1",
    spoolPath: spoolFile, ...h.options,
  });

  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(spoolFile, "utf8"), /ledger_inoperative/);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test send.test.mjs`
Expected: FAIL — `SEND_CAUSES.EXCHANGE_CAPPED` is undefined.

- [ ] **Step 3: Implement**

Add to `SEND_CAUSES`:

```js
  EXCHANGE_CAPPED: "exchange_capped",
```

Import `checkCaps`, `recordSend` and `ledgerPath` from `./ledger.mjs`. In `sendMessage`, accept `ledgerPath: ledger = ledgerPath()` and `conversation = null`. After the target resolves and before delivery, and only when `dryRun` is false:

```js
  if (!dryRun) {
    const verdict = checkCaps(ledger, { now: now(), conversation });
    if (!verdict.allowed) return fail(SEND_CAUSES.EXCHANGE_CAPPED, verdict.detail, target.kind);
    // The guard fails open on a broken ledger rather than refusing every send,
    // but it must never do so silently: an inoperative cost guard that nobody
    // knows is inoperative is the shape of an overnight runaway (spec 4.7).
    if (verdict.inoperative) {
      spool(spoolPath, spoolFallbackPath, {
        now, to, kind: target.kind, cause: "ledger_inoperative",
        detail: `the exchange-volume ledger at ${ledger} could not be read; caps are not being enforced`,
        message: "",
      });
    }
  }
```

After a successful delivery, and only when `dryRun` is false, call `recordSend(ledger, { now: now(), conversation })`.

- [ ] **Step 4: Run the whole suite**

Run: `cd MCP-Servers/bridges/relay && node --test`
Expected: PASS.

- [ ] **Step 5: Add the cause to the spec's authoritative list**

Section 6 of the spec enumerates the cause set and declares itself the authority: "a cause present in the code and absent here is a defect in the spec". Add `exchange_capped` to that list, with the parenthetical `(4.7)`.

- [ ] **Step 6: Commit**

```bash
git add MCP-Servers/bridges/relay/client.mjs MCP-Servers/bridges/relay/send.test.mjs docs/superpowers/specs/2026-08-23-cross-agent-relay-design.md
git commit -m "relay: enforce the exchange-volume caps in the send path"
```

---

### Task 9: Record unknown host metadata keys

Found by the plan's own self-review: section 4.4b requires that relay "passes unknown keys through and records each new key once to the spool", and no task above did the recording. Without it the pass-through design has no drift detector at all, and the fixture tests structurally cannot be one — they would keep passing if Codex renamed every field tomorrow.

Depends on Tasks 2 and 8. Order relative to nothing else.

**Files:**
- Modify: `MCP-Servers/bridges/relay/identity.mjs`
- Modify: `MCP-Servers/bridges/relay/identity.test.mjs`
- Modify: `MCP-Servers/bridges/relay/client.mjs` — `sendMessage`

**Interfaces:**
- Consumes: `buildHostMetadata` from Task 2, the `spool` helper already in `client.mjs`.
- Produces: `newHostKeys(kept)` returns an array of key names not previously seen by this process, and remembers them.

- [ ] **Step 1: Write the failing tests**

Append to `identity.test.mjs`:

```js
import { newHostKeys } from "./identity.mjs";

test("a key is reported the first time it is seen and not after", () => {
  // Two assertions on purpose. A test that only checks the first call passes
  // when deduplication is absent, and one that only checks the second passes
  // when reporting is absent entirely.
  const first = newHostKeys({ turn_id: "t", brand_new_field: 1 });
  const second = newHostKeys({ turn_id: "t", brand_new_field: 1 });

  assert.equal(first.includes("brand_new_field"), true);
  assert.equal(second.includes("brand_new_field"), false);
});

test("keys measured on 2026-08-26 are known and never reported", () => {
  // The point of the detector is drift. Reporting the fields that were present
  // when this was written would make every send noisy and train the reader to
  // ignore it.
  assert.deepEqual(newHostKeys({ thread_id: "t", turn_id: "u", thread_source: "user", model: "m", reasoning_effort: "high" }), []);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: FAIL — `newHostKeys is not a function`.

- [ ] **Step 3: Implement**

Append to `identity.mjs`:

```js
// The fields observed on 2026-08-26. Anything outside this set is drift worth a
// human's attention, which is the half of the pass-through design that fixture
// tests cannot supply (spec 4.4b, 4.4c).
const KNOWN_HOST_KEYS = new Set([
  "thread_id", "turn_id", "turn_started_at_unix_ms", "thread_source",
  "model", "reasoning_effort", "sandbox", "sandbox_mode",
  "node_repl_disabled", "auto_review_enabled", "node_repl_auto_review_required",
]);

// Deduplicated in memory, which is coherent because only the long-lived MCP
// face sees this channel; the per-invocation CLI never does (spec 4.4b).
const reported = new Set();

export function newHostKeys(kept) {
  const fresh = [];
  for (const name of Object.keys(kept || {})) {
    if (KNOWN_HOST_KEYS.has(name) || reported.has(name)) continue;
    reported.add(name);
    fresh.push(name);
  }
  return fresh.sort();
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd MCP-Servers/bridges/relay && node --test identity.test.mjs`
Expected: PASS.

- [ ] **Step 5: Record them from the send path**

In `sendMessage`, after building the host metadata for the envelope and before delivery:

```js
  const fresh = newHostKeys(buildHostMetadata(identity?.host).kept);
  if (fresh.length > 0) {
    spool(spoolPath, spoolFallbackPath, {
      now, to, kind: target.kind, cause: "host_metadata_drift",
      detail: `host turn metadata carried keys not seen before: ${fresh.join(", ")}. Passed through as usual; review whether any should be on the deny-list.`,
      message: "",
    });
  }
```

- [ ] **Step 6: Run the whole suite**

Run: `cd MCP-Servers/bridges/relay && node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add MCP-Servers/bridges/relay/identity.mjs MCP-Servers/bridges/relay/identity.test.mjs MCP-Servers/bridges/relay/client.mjs
git commit -m "relay: report host metadata keys not seen before"
```

---

## Acceptance

Not a task, because it cannot be run from a test suite. After Task 8:

1. From a **live Codex session**, call `relay_list` then `relay_send` to a Claude target. The delivered envelope must read `(codex, <workspace>)`, must say "metadata the host attached to this call", and must carry a `To reply:` line naming the Codex thread id.

   **Word the request as "call the MCP tool", never "run this in exec".** `exec` is overloaded in Codex: there is a shell exec and there is the code-mode JavaScript sandbox where the `tools` object lives. Asking for exec gets a shell, where `tools` is undefined and the attempt fails with `ReferenceError: tools is not defined` — which looks like a bridge failure and is not one. Observed 2026-08-27.
2. **Reply to that address** from the Claude session. It must arrive in the Codex session.
3. Confirm `%TEMP%\cross-agent-relay-ledger.log` gained one line per delivered message.

Step 2 is the acceptance that matters: it is the capability this whole plan exists to create, and no unit test can demonstrate it.
