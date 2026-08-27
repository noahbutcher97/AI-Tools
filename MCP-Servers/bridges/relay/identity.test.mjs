import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODEX_META_KEY,
  HOST_META_MAX_BYTES,
  buildHostMetadata,
  detectRequestOrigin,
  resolveCallerIdentity,
} from "./identity.mjs";

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

// -- The host metadata container (spec 4.4b) --

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
  // Intended, not incidental: "session" is on the deny-list and the id is
  // already from.id (spec 4.4b).
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

// -- Resolving one identity from whichever channel the host offers (spec 4.4a) --

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
