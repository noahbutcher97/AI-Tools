// Pure parsers for Perforce text output and form specs. Kept side-effect-free
// and dependency-free so they can be unit-tested with `node --test` without
// importing the MCP server (which would launch over stdio on import).

export function parseOpenedFiles(openedOutput) {
  return openedOutput
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\/\/[^#]+)#\d+/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

// Description body in a `p4 change -o` form spec is the tab-indented block
// following the "Description:" header, terminated by the next top-level
// section header (e.g., "Files:", "Jobs:"). Tab-indented lines are dedented.
export function parseChangeSpecDescription(spec) {
  const lines = spec.split(/\r?\n/);
  let inDesc = false;
  const out = [];
  for (const line of lines) {
    if (inDesc) {
      if (/^[A-Z][a-zA-Z]*:/.test(line)) break;
      out.push(line.startsWith("\t") ? line.slice(1) : line);
    } else if (/^Description:\s*$/.test(line)) {
      inDesc = true;
    }
  }
  return out.join("\n").trim();
}

export function parseSubmittedChangelist(output) {
  const m = output.match(/Change (\d+) submitted\./);
  return m ? m[1] : null;
}

// Fixed-literal matcher for a single `p4 opened` line. The line format is
// stable across Perforce versions:
//   //depot/path#rev - <action> change <N> (<type>)
//   //depot/path#rev - <action> default change (<type>)
// Group 1 captures the numeric CL; group 2 captures the literal 'default'.
// No dynamic construction → no ReDoS surface from caller-supplied CL.
// Action class allows '/' to cover move/add and move/delete pairs.
export const CL_LINE_RE = / - [\w/]+ (?:change (\d+)|(default) change) \(/;

// Mirror Perforce's on-storage normalization so verify-match compares
// what would round-trip, not raw input. Perforce strips per-line trailing
// whitespace when storing a change spec; we also normalize line endings.
export function normalizeDescription(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
