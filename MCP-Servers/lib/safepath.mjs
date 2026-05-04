// MCP-Servers/lib/safepath.mjs
// Path-input validation used by bridge servers at runtime. Identical to
// Installers/MCP-Suite/lib/safepath.mjs — duplicated by design so bridges
// have no dependency on the installer (one-way: installer can depend on
// bridges, not the other way around).

import { resolve, isAbsolute } from "path";

/**
 * Validate and normalize a path string.
 * Throws on non-string, empty, or control-char input.
 * Returns a trimmed, normalized absolute path.
 */
export function safePath(input, opts = {}) {
  const { label = "path", requireAbsolute = true } = opts;

  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error(`${label} cannot be empty`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) {
    throw new Error(`${label} contains control characters`);
  }
  const resolved = resolve(trimmed);
  if (requireAbsolute && !isAbsolute(resolved)) {
    throw new Error(`${label} must be an absolute path: ${input}`);
  }
  return resolved;
}

/**
 * Join base + segments after validating the base via safePath().
 * Segments are treated as trusted constants (filenames defined in code).
 */
export function safeJoin(base, ...segments) {
  const validatedBase = safePath(base, { label: "base path" });
  let result = validatedBase;
  for (const seg of segments) {
    if (typeof seg !== "string") continue;
    if (seg === "") continue;
    if (seg.includes("\x00")) {
      throw new Error(`segment contains null byte: ${seg}`);
    }
    result = resolve(result, seg);
  }
  return result;
}
