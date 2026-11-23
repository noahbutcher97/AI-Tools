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

// Names are unconstrained; shape and size are not (spec 4.4b). Passing unknown
// NAMES through is the point: an allow-list would drop new host fields silently
// and the blob would decay toward whatever was known the day it was written.
// Passing unknown SHAPES through is not, and the two are easy to conflate — a
// deny-list matching key names cannot see a credential nested under an
// innocuous parent, so only scalars survive.
export const HOST_META_DENY = [
  "token", "secret", "password", "passwd", "apikey", "key", "auth",
  "credential", "bearer", "cookie", "session", "jwt", "signature", "sig", "private",
];

// The header is prepended to every relayed message and travels the delegate
// path inside a spawned prompt, so an unbounded blob is a cost paid per send
// rather than once. The measured blob is roughly 300 bytes; this is headroom.
export const HOST_META_MAX_BYTES = 2048;

// Over-matches on purpose: dropping an innocuous field costs a line of
// metadata, missing a credential costs a credential.
function isDenied(name) {
  const flat = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return HOST_META_DENY.some((needle) => flat.includes(needle));
}

export function buildHostMetadata(raw) {
  const kept = {};
  const dropped = [];
  if (!isObject(raw)) return { kept, dropped, overflow: false };

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
  // the cap and take the legitimate fields with it. Carrying nothing beats a
  // truncation, which would produce invalid JSON, and beats a silent subset,
  // which no recipient could detect.
  if (Buffer.byteLength(JSON.stringify(kept), "utf8") > HOST_META_MAX_BYTES) {
    return { kept: {}, dropped, overflow: true };
  }
  return { kept, dropped, overflow: false };
}

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

// Returns null rather than a null-filled object, matching the optional-chaining
// idiom at both call sites.
export function resolveCallerIdentity({ env = process.env, extra = null } = {}) {
  const fromRequest = detectRequestOrigin(extra);
  const fromEnv = fromEnvironment(env);

  // The two are not expected to co-occur: a Codex-spawned server has no
  // identity in its environment, a Claude-spawned one receives no Codex turn
  // metadata. Agreement reports the per-call channel, being the one that cannot
  // go stale. DISAGREEMENT claims nothing at all: two channels that should
  // never both speak, contradicting each other, is a condition this design did
  // not anticipate, and an unanticipated condition is the worst moment to stamp
  // VERIFIED on whichever value a tiebreak happens to select (spec 4.4a).
  if (fromRequest && fromEnv && fromRequest.id !== fromEnv.id) return null;
  return fromRequest || fromEnv;
}

// A watch activates an issued grant. Require the provider-specific evidence
// for this entry point, and agreement across all populated identity fields.
export function resolveWatchCaller(channel, { env = process.env, extra } = {}) {
  const identity = channel === "cli" ? fromEnvironment(env) : detectRequestOrigin(extra);
  if (!identity) return null;
  if (channel === "mcp") {
    const meta = extra?._meta;
    if (meta?.[CODEX_META_KEY]?.thread_id !== identity.id ||
        (meta.threadId !== undefined && meta.threadId !== identity.id)) return null;
  } else if (channel !== "cli") return null;
  for (const [name, provider] of IDENTITY_VARS) {
    const id = env?.[name];
    if (id && (id !== identity.id || provider !== identity.provider)) return null;
  }
  return identity;
}

// The fields observed on 2026-08-26. Anything outside this set is drift worth a
// human's attention.
//
// This is the half of the pass-through design that fixture tests CANNOT supply.
// Those run against a point-in-time capture and would keep passing if Codex
// renamed every field tomorrow; that is a property of fixtures, not a shortfall
// more fixtures would close. The two are designed as a pair (spec 4.4b, 4.4c).
const KNOWN_HOST_KEYS = new Set([
  "thread_id", "turn_id", "turn_started_at_unix_ms", "thread_source",
  "model", "reasoning_effort", "sandbox", "sandbox_mode",
  "node_repl_disabled", "auto_review_enabled", "node_repl_auto_review_required",
]);

// Deduplicated in memory, which is coherent because only the long-lived MCP
// face sees this channel; the per-invocation CLI never does, having no request
// to read (spec 4.4b).
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
