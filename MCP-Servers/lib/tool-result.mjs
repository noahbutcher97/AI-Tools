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
