// Unit tests for the pure Perforce parsers.
//
// Why these exist: each parser sits on a regression-prone surface (Perforce
// form output, line format, CRLF/whitespace drift). The bugs that bit us in
// the field — default-CL scope leak, description verify-match mismatching on
// trailing whitespace — would have been caught here.
//
// Run with: `npm test` (or `node --test`) from this bridge's directory.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseOpenedFiles,
  parseChangeSpecDescription,
  parseSubmittedChangelist,
  normalizeDescription,
  CL_LINE_RE,
} from "./parsers.mjs";

// ─────────────────────────────────────────────────────────────────────────
// parseOpenedFiles
// ─────────────────────────────────────────────────────────────────────────

describe("parseOpenedFiles", () => {
  it("extracts depot paths from a typical `p4 opened` output", () => {
    const input = [
      "//depot/main/foo.txt#3 - edit change 12345 (text)",
      "//depot/main/bar.txt#1 - add change 12345 (text)",
      "//depot/main/baz.txt#7 - delete default change (text)",
    ].join("\n");

    assert.deepEqual(parseOpenedFiles(input), [
      "//depot/main/foo.txt",
      "//depot/main/bar.txt",
      "//depot/main/baz.txt",
    ]);
  });

  it("handles paths with spaces", () => {
    const input = "//depot/main/some path/file name.txt#3 - edit default change (text)";
    assert.deepEqual(parseOpenedFiles(input), ["//depot/main/some path/file name.txt"]);
  });

  it("returns [] on empty input", () => {
    assert.deepEqual(parseOpenedFiles(""), []);
  });

  it("ignores non-matching lines (e.g. blank lines, p4 info messages)", () => {
    const input = [
      "",
      "//depot/main/foo.txt#3 - edit change 12345 (text)",
      "Some other info line - no depot path here",
      "",
    ].join("\n");
    assert.deepEqual(parseOpenedFiles(input), ["//depot/main/foo.txt"]);
  });

  it("handles CRLF line endings", () => {
    const input = "//depot/a.txt#1 - edit default change (text)\r\n//depot/b.txt#2 - add default change (text)\r\n";
    assert.deepEqual(parseOpenedFiles(input), ["//depot/a.txt", "//depot/b.txt"]);
  });

  it("preserves order (callers slice this list for chunked argv)", () => {
    const input = [
      "//depot/z.txt#1 - edit default change (text)",
      "//depot/a.txt#1 - edit default change (text)",
      "//depot/m.txt#1 - edit default change (text)",
    ].join("\n");
    assert.deepEqual(parseOpenedFiles(input), ["//depot/z.txt", "//depot/a.txt", "//depot/m.txt"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseChangeSpecDescription
// ─────────────────────────────────────────────────────────────────────────

const SPEC_BASIC = `# A Perforce Change Specification.
#
#  Change:      The change number.
#

Change: 12345

Client: my_client

User:\tmy_user

Status: pending

Description:
\tImplement feature X.
\t
\tBullets:
\t- Added foo
\t- Fixed bar

Type:\tpublic

Files:
\t//depot/main/foo.txt\t# edit
\t//depot/main/bar.txt\t# add
`;

describe("parseChangeSpecDescription", () => {
  it("extracts a multi-line description with blank lines preserved", () => {
    const desc = parseChangeSpecDescription(SPEC_BASIC);
    assert.equal(
      desc,
      "Implement feature X.\n\nBullets:\n- Added foo\n- Fixed bar",
    );
  });

  it("handles a single-line description", () => {
    const spec = `Change: 1

Description:
\tQuick fix.

Files:
\t//depot/x.txt\t# edit
`;
    assert.equal(parseChangeSpecDescription(spec), "Quick fix.");
  });

  it("returns empty string on an empty description block", () => {
    const spec = `Change: 1

Description:

Files:
\t//depot/x.txt\t# edit
`;
    assert.equal(parseChangeSpecDescription(spec), "");
  });

  it("does NOT terminate on a tab-indented section-name-looking line (e.g. 'TODO:' inside desc)", () => {
    // The terminator is "un-indented section header". Tab-indented content
    // that looks like a header (TODO:, NOTE:) must survive intact.
    const spec = `Change: 1

Description:
\tTODO:
\tFix the underlying issue.

Files:
\t//depot/x.txt\t# edit
`;
    assert.equal(parseChangeSpecDescription(spec), "TODO:\nFix the underlying issue.");
  });

  it("terminates correctly on 'Jobs:' (an alternative section header)", () => {
    const spec = `Change: 1

Description:
\tThe description.

Jobs:
\tJOB-1234

Files:
\t//depot/x.txt\t# edit
`;
    assert.equal(parseChangeSpecDescription(spec), "The description.");
  });

  it("handles CRLF line endings in the spec", () => {
    const spec = "Change: 1\r\n\r\nDescription:\r\n\tLine one.\r\n\tLine two.\r\n\r\nFiles:\r\n\t//depot/x.txt\t# edit\r\n";
    assert.equal(parseChangeSpecDescription(spec), "Line one.\nLine two.");
  });

  it("returns empty string when no Description: header is present", () => {
    const spec = `Change: 1

Files:
\t//depot/x.txt\t# edit
`;
    assert.equal(parseChangeSpecDescription(spec), "");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseSubmittedChangelist
// ─────────────────────────────────────────────────────────────────────────

describe("parseSubmittedChangelist", () => {
  it("extracts the CL number from a numbered-CL submit", () => {
    const output = [
      "Submitting change 12345.",
      "Locking 3 files ...",
      "edit //depot/foo.txt#4",
      "Change 12345 submitted.",
    ].join("\n");
    assert.equal(parseSubmittedChangelist(output), "12345");
  });

  it("extracts the renumbered CL from a default-CL submit", () => {
    // p4 assigns a new numeric CL when submitting from default.
    const output = [
      "Change 12346 created with 3 open file(s).",
      "Submitting change 12346.",
      "Locking 3 files ...",
      "edit //depot/foo.txt#5",
      "Change 12346 submitted.",
    ].join("\n");
    assert.equal(parseSubmittedChangelist(output), "12346");
  });

  it("returns null when the submitted marker is absent", () => {
    const output = "Change 12345 created with 3 open file(s).";
    assert.equal(parseSubmittedChangelist(output), null);
  });

  it("returns null on empty output", () => {
    assert.equal(parseSubmittedChangelist(""), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// normalizeDescription — mirror Perforce's on-storage normalization
// ─────────────────────────────────────────────────────────────────────────

describe("normalizeDescription", () => {
  it("strips per-line trailing whitespace (matches Perforce storage)", () => {
    assert.equal(normalizeDescription("Line one.   \nLine two.\t\t\n"), "Line one.\nLine two.");
  });

  it("normalizes CRLF to LF", () => {
    assert.equal(normalizeDescription("Line one.\r\nLine two.\r\n"), "Line one.\nLine two.");
  });

  it("outer-trims leading and trailing whitespace", () => {
    assert.equal(normalizeDescription("\n\n  Hello.  \n\n"), "Hello.");
  });

  it("returns empty string for whitespace-only input", () => {
    assert.equal(normalizeDescription("   \n\t\n  "), "");
  });

  it("is idempotent — normalize(normalize(x)) === normalize(x)", () => {
    const messy = "Line A.   \r\n   \r\nLine B.\t\n";
    const once = normalizeDescription(messy);
    const twice = normalizeDescription(once);
    assert.equal(once, twice);
  });

  it("preserves intentional blank lines between paragraphs", () => {
    assert.equal(
      normalizeDescription("Paragraph one.\n\nParagraph two.\n"),
      "Paragraph one.\n\nParagraph two.",
    );
  });

  it("preserves leading indentation within description body (Perforce only strips trailing)", () => {
    assert.equal(
      normalizeDescription("  - Bullet one.\n  - Bullet two.\n"),
      "- Bullet one.\n  - Bullet two.",
    );
    // The outer .trim() removes leading whitespace from the very first line,
    // which is the documented Perforce behavior (trailing-only, plus an outer
    // trim). Within-line leading whitespace on subsequent lines is preserved.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CL_LINE_RE — defends against scope-leak when -c default is ignored server-side
// ─────────────────────────────────────────────────────────────────────────

describe("CL_LINE_RE", () => {
  it("captures the numeric CL from a numbered-CL line", () => {
    const line = "//depot/main/foo.txt#3 - edit change 12345 (text)";
    const m = CL_LINE_RE.exec(line);
    assert.ok(m);
    assert.equal(m[1], "12345");
    assert.equal(m[2], undefined);
  });

  it("captures the 'default' marker from a default-CL line", () => {
    const line = "//depot/main/foo.txt#3 - edit default change (text)";
    const m = CL_LINE_RE.exec(line);
    assert.ok(m);
    assert.equal(m[1], undefined);
    assert.equal(m[2], "default");
  });

  it("does NOT match a line missing the change marker", () => {
    assert.equal(CL_LINE_RE.exec("//depot/foo.txt#3 - some other thing"), null);
  });

  it("does NOT match a line where 'change 222' is a prefix of 'change 2224'", () => {
    // Critical: scoping CL 222 must not match a line for CL 2224.
    const line = "//depot/main/foo.txt#3 - edit change 2224 (binary)";
    const m = CL_LINE_RE.exec(line);
    assert.ok(m);
    assert.equal(m[1], "2224");
    assert.notEqual(m[1], "222");
  });

  it("matches across common action verbs including slash actions (move/add, move/delete)", () => {
    for (const action of ["edit", "add", "delete", "integrate", "branch", "move/add", "move/delete"]) {
      const line = `//depot/foo.txt#1 - ${action} change 1 (text)`;
      const m = CL_LINE_RE.exec(line);
      assert.ok(m, `action '${action}' should match`);
      assert.equal(m[1], "1");
    }
  });

  it("matches slash actions on default-CL lines too (file rename in default CL)", () => {
    const line = "//depot/foo_new.txt#1 - move/add default change (text)";
    const m = CL_LINE_RE.exec(line);
    assert.ok(m);
    assert.equal(m[2], "default");
  });
});
