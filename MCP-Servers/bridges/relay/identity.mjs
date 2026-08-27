// Resolving who is calling relay, from whichever channel the host offers.
//
// Spec 4.4a. Two channels exist and neither is universal: Claude publishes a
// session id into the environment of servers it spawns, Codex publishes a
// thread id in the metadata of every request. Both are written by the host and
// not by the calling agent, which is what makes either usable as identity.
//
// The limit that survives all of this: relay cannot authenticate its own MCP
// client. Whoever spawns a server controls both its environment and the
// metadata on its requests, so an agent able to start a process can run its own
// relay and hand it any identity. What relay guarantees is that it did not take
// the identity from the caller's arguments, not that no adversary could have
// produced it (spec 4.4a, and the risk register in section 7).

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
