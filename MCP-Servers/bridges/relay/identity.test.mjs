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
