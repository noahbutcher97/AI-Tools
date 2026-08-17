// Shared MCP tool-result helpers.
//
// Every bridge ultimately produces the same response shape — an array of
// content blocks with optional isError. These helpers centralize that shape
// so bridges don't drift on formatting (pretty-print spaces, error flags,
// empty-output fallbacks) over time.
//
// Three flavors:
//   toolJsonResult(data, opts?)  → pretty-printed JSON
//   toolTextResult(text)         → raw text, with "(no output)" fallback
//   toolErrorResult(text)        → raw text + isError: true
//
// The output shape matches MCP SDK ServerResult expectations
// ({ content: [{ type, text }], isError? }).

export function toolJsonResult(data, { compact = false } = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, compact ? 0 : 2),
      },
    ],
  };
}

// toolListResult(items, opts) → pretty-printed JSON with a completeness envelope
//
// Every list-returning tool shares this shape so a caller can always tell
// coverage from truncation. A page whose length equals its limit is otherwise
// indistinguishable from a complete result, which is how a truncated Confluence
// space read as the whole space and a capped Miro page read as the whole board.
//
// Three rules are enforced rather than documented, because documenting them is
// what failed before:
//
//   1. `isLast` is required. A list result cannot be constructed without
//      stating whether it is complete.
//   2. `total` defaults to an explicit null. It is never derived from the page
//      length — a fabricated total is precisely what makes truncation invisible.
//      Pass a real one only when the upstream API supplies it.
//   3. A result cannot claim to be both truncated and the last page.
export function toolListResult(items, opts = {}) {
  const {
    isLast,
    total = null,
    scope,
    warning,
    truncated,
    start,
    limit,
    extra,
    itemsKey = "items",
  } = opts;

  if (typeof isLast !== "boolean") {
    throw new Error(
      "toolListResult: isLast is required and must be a boolean — a list response must state "
      + "whether it is complete, since a full page is otherwise indistinguishable from the last one.",
    );
  }

  const list = Array.isArray(items) ? items : [];
  const count = list.length;

  if (total !== null && total !== undefined && total < count) {
    throw new Error(
      `toolListResult: total (${total}) is smaller than the ${count} items returned — `
      + "an incoherent total misleads more than an absent one.",
    );
  }

  if (isLast && truncated) {
    throw new Error(
      "toolListResult: a truncated result cannot also be the last page — if a server-side cap "
      + "was applied, isLast must be false.",
    );
  }

  // Tool-specific metadata the envelope does not model — for example a sweep
  // bounded by a Perforce depot, where "complete" means complete for that depot
  // and the caller must be able to see which. It may not overwrite the
  // completeness fields, or a tool could quietly reintroduce the very ambiguity
  // this helper exists to prevent.
  const RESERVED = ["count", "total", "isLast", "truncated"];
  if (extra) {
    const clash = RESERVED.filter((k) => k in extra);
    if (clash.length > 0) {
      throw new Error(
        `toolListResult: extra may not overwrite completeness fields (${clash.join(", ")}).`,
      );
    }
  }

  const body = { count, total: total ?? null, isLast };
  if (start !== undefined) body.start = start;
  if (limit !== undefined) body.limit = limit;
  if (scope !== undefined) body.scope = scope;
  if (warning !== undefined) body.warning = warning;
  if (truncated !== undefined) body.truncated = truncated;
  if (extra) Object.assign(body, extra);
  body[itemsKey] = list;

  return toolJsonResult(body);
}

export function toolTextResult(text) {
  return {
    content: [{ type: "text", text: text || "(no output)" }],
  };
}

export function toolErrorResult(text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}
