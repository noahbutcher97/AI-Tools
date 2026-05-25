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
  parseCreatedChangelist,
  normalizeDescription,
  CL_LINE_RE,
  buildCreateChangeSpec,
  buildEditArgs,
  buildRevertArgs,
  buildLockArgs,
  buildUnlockArgs,
  buildAddArgs,
  buildDeleteArgs,
  buildShelveArgs,
  buildUnshelveArgs,
  buildIntegrateArgs,
  buildMergeArgs,
  buildCopyArgs,
  replaceDescriptionInSpec,
  buildReopenArgs,
  buildMoveArgs,
  buildChangesArgs,
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
// parseCreatedChangelist
// ─────────────────────────────────────────────────────────────────────────

describe("parseCreatedChangelist", () => {
  it("extracts the CL number from `p4 change -i` output", () => {
    assert.equal(parseCreatedChangelist("Change 12345 created."), "12345");
  });

  it("returns null when no created marker exists", () => {
    assert.equal(parseCreatedChangelist("Change 12345 updated."), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCreateChangeSpec
// ─────────────────────────────────────────────────────────────────────────

describe("buildCreateChangeSpec", () => {
  it("builds a new changelist spec with tab-indented description lines", () => {
    assert.equal(
      buildCreateChangeSpec({
        client: "my-client",
        description: "Line one.\n\nLine two.",
      }),
      [
        "Change: new",
        "Client: my-client",
        "",
        "Description:",
        "\tLine one.",
        "\t",
        "\tLine two.",
        "",
      ].join("\n"),
    );
  });

  it("rejects empty descriptions after normalization", () => {
    assert.throws(
      () => buildCreateChangeSpec({ client: "my-client", description: " \n\t " }),
      /Description must be non-empty/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildEditArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildEditArgs", () => {
  it("builds args for opening files in the default changelist (no -c)", () => {
    assert.deepEqual(
      buildEditArgs({ files: ["//depot/a.cpp", "//depot/b.cpp"] }),
      ["edit", "//depot/a.cpp", "//depot/b.cpp"],
    );
  });

  it("builds args for opening files in a numbered changelist", () => {
    assert.deepEqual(
      buildEditArgs({ files: ["//depot/a.cpp"], changelist: "12345" }),
      ["edit", "-c", "12345", "//depot/a.cpp"],
    );
  });

  it("treats changelist='default' the same as omitted (no -c)", () => {
    assert.deepEqual(
      buildEditArgs({ files: ["//depot/a.cpp"], changelist: "default" }),
      ["edit", "//depot/a.cpp"],
    );
  });

  it("adds -n in preview mode", () => {
    assert.deepEqual(
      buildEditArgs({ files: ["//depot/a.cpp"], preview: true }),
      ["edit", "-n", "//depot/a.cpp"],
    );
  });

  it("combines preview + numbered changelist", () => {
    assert.deepEqual(
      buildEditArgs({ files: ["//depot/a.cpp"], changelist: "777", preview: true }),
      ["edit", "-n", "-c", "777", "//depot/a.cpp"],
    );
  });

  it("preserves file order and supports wildcard paths", () => {
    assert.deepEqual(
      buildEditArgs({ files: ["//depot/z/...", "//depot/a.cpp", "//depot/m.cpp"] }),
      ["edit", "//depot/z/...", "//depot/a.cpp", "//depot/m.cpp"],
    );
  });

  it("rejects empty file lists", () => {
    assert.throws(
      () => buildEditArgs({ files: [] }),
      /At least one file path is required/,
    );
  });

  it("rejects whitespace-only file entries", () => {
    assert.throws(
      () => buildEditArgs({ files: ["//depot/a.cpp", "   "] }),
      /File paths must be non-empty strings/,
    );
  });

  it("rejects non-numeric, non-'default' changelists", () => {
    assert.throws(
      () => buildEditArgs({ files: ["//depot/a.cpp"], changelist: "bogus" }),
      /Invalid changelist 'bogus'/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildRevertArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildRevertArgs", () => {
  it("builds plain revert for default CL", () => {
    assert.deepEqual(
      buildRevertArgs({ files: ["//depot/a.cpp"] }),
      ["revert", "//depot/a.cpp"],
    );
  });

  it("adds -n in preview mode (default-safer pattern)", () => {
    assert.deepEqual(
      buildRevertArgs({ files: ["//depot/a.cpp"], preview: true }),
      ["revert", "-n", "//depot/a.cpp"],
    );
  });

  it("supports -k (keep workspace file) for non-destructive revert", () => {
    assert.deepEqual(
      buildRevertArgs({ files: ["//depot/a.cpp"], keepWorkspaceFile: true }),
      ["revert", "-k", "//depot/a.cpp"],
    );
  });

  it("supports -a (revert only unchanged files)", () => {
    assert.deepEqual(
      buildRevertArgs({ files: ["//depot/a.cpp"], unchangedOnly: true }),
      ["revert", "-a", "//depot/a.cpp"],
    );
  });

  it("combines flags in canonical order: -n -k -a -c", () => {
    assert.deepEqual(
      buildRevertArgs({
        files: ["//depot/a.cpp"],
        changelist: "55",
        preview: true,
        keepWorkspaceFile: true,
        unchangedOnly: true,
      }),
      ["revert", "-n", "-k", "-a", "-c", "55", "//depot/a.cpp"],
    );
  });

  it("rejects empty file lists", () => {
    assert.throws(() => buildRevertArgs({ files: [] }), /At least one file path is required/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildLockArgs / buildUnlockArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildLockArgs", () => {
  it("builds lock args for default CL", () => {
    assert.deepEqual(
      buildLockArgs({ files: ["//depot/Foo.uasset"] }),
      ["lock", "//depot/Foo.uasset"],
    );
  });

  it("includes -c when changelist is numeric", () => {
    assert.deepEqual(
      buildLockArgs({ files: ["//depot/Foo.uasset"], changelist: "42" }),
      ["lock", "-c", "42", "//depot/Foo.uasset"],
    );
  });

  it("rejects empty file list (no workspace-wide lock allowed)", () => {
    assert.throws(() => buildLockArgs({ files: [] }), /At least one file path is required/);
  });
});

describe("buildUnlockArgs", () => {
  it("builds unlock args for default CL", () => {
    assert.deepEqual(
      buildUnlockArgs({ files: ["//depot/Foo.uasset"] }),
      ["unlock", "//depot/Foo.uasset"],
    );
  });

  it("includes -c when changelist is numeric", () => {
    assert.deepEqual(
      buildUnlockArgs({ files: ["//depot/Foo.uasset"], changelist: "42" }),
      ["unlock", "-c", "42", "//depot/Foo.uasset"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildAddArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildAddArgs", () => {
  it("builds plain add for default CL", () => {
    assert.deepEqual(
      buildAddArgs({ files: ["new.cpp"] }),
      ["add", "new.cpp"],
    );
  });

  it("supports preview, changelist, and filetype together", () => {
    assert.deepEqual(
      buildAddArgs({ files: ["new.uasset"], preview: true, changelist: "9", filetype: "binary+l" }),
      ["add", "-n", "-c", "9", "-t", "binary+l", "new.uasset"],
    );
  });

  it("accepts filetype with leading '+' modifier-only form ('+S2')", () => {
    assert.deepEqual(
      buildAddArgs({ files: ["x.txt"], filetype: "+S2" }),
      ["add", "-t", "+S2", "x.txt"],
    );
  });

  it("rejects malicious filetype containing flag-like characters", () => {
    // Defends against `-t " -d --foo"` injection on the argv boundary.
    assert.throws(
      () => buildAddArgs({ files: ["x.txt"], filetype: "-d -rf" }),
      /Invalid filetype/,
    );
    assert.throws(
      () => buildAddArgs({ files: ["x.txt"], filetype: "text; rm" }),
      /Invalid filetype/,
    );
  });

  it("rejects whitespace-only filetype", () => {
    assert.throws(
      () => buildAddArgs({ files: ["x.txt"], filetype: "   " }),
      /filetype must be non-empty when provided/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildDeleteArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildDeleteArgs", () => {
  it("builds plain delete for default CL", () => {
    assert.deepEqual(
      buildDeleteArgs({ files: ["//depot/a.cpp"] }),
      ["delete", "//depot/a.cpp"],
    );
  });

  it("combines preview + keep-workspace-file + numbered CL", () => {
    assert.deepEqual(
      buildDeleteArgs({
        files: ["//depot/a.cpp"],
        preview: true,
        keepWorkspaceFile: true,
        changelist: "12",
      }),
      ["delete", "-n", "-k", "-c", "12", "//depot/a.cpp"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildShelveArgs / buildUnshelveArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildShelveArgs", () => {
  it("builds shelve for a numbered CL with no file subset", () => {
    assert.deepEqual(
      buildShelveArgs({ changelist: "100" }),
      ["shelve", "-c", "100"],
    );
  });

  it("restricts to a file subset when provided", () => {
    assert.deepEqual(
      buildShelveArgs({ changelist: "100", files: ["//depot/a.cpp"] }),
      ["shelve", "-c", "100", "//depot/a.cpp"],
    );
  });

  it("adds -r -f when replace=true (overwrites existing shelf)", () => {
    assert.deepEqual(
      buildShelveArgs({ changelist: "100", replace: true }),
      ["shelve", "-r", "-f", "-c", "100"],
    );
  });

  it("rejects the literal 'default' (cannot shelve the default CL)", () => {
    assert.throws(
      () => buildShelveArgs({ changelist: "default" }),
      /Invalid changelist 'default'/,
    );
  });
});

describe("buildUnshelveArgs", () => {
  it("builds unshelve from a source CL into the default CL", () => {
    assert.deepEqual(
      buildUnshelveArgs({ sourceChangelist: "100" }),
      ["unshelve", "-s", "100"],
    );
  });

  it("routes unshelved files into a numbered target CL", () => {
    assert.deepEqual(
      buildUnshelveArgs({ sourceChangelist: "100", targetChangelist: "200" }),
      ["unshelve", "-s", "100", "-c", "200"],
    );
  });

  it("supports preview + file subset + numbered target CL", () => {
    assert.deepEqual(
      buildUnshelveArgs({
        sourceChangelist: "100",
        targetChangelist: "200",
        preview: true,
        files: ["//depot/a.cpp"],
      }),
      ["unshelve", "-s", "100", "-n", "-c", "200", "//depot/a.cpp"],
    );
  });

  it("rejects non-numeric source CL (must shelve to a real CL)", () => {
    assert.throws(
      () => buildUnshelveArgs({ sourceChangelist: "default" }),
      /Invalid changelist 'default'/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildIntegrateArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildIntegrateArgs", () => {
  it("builds plain integrate between two paths", () => {
    assert.deepEqual(
      buildIntegrateArgs({ source: "//depot/main/...", target: "//depot/branch/..." }),
      ["integrate", "//depot/main/...", "//depot/branch/..."],
    );
  });

  it("supports preview + changelist + force + reverse flags in canonical order", () => {
    assert.deepEqual(
      buildIntegrateArgs({
        source: "//depot/main/foo.cpp",
        target: "//depot/branch/foo.cpp",
        preview: true,
        force: true,
        reverse: true,
        changelist: "77",
      }),
      ["integrate", "-n", "-f", "-r", "-c", "77", "//depot/main/foo.cpp", "//depot/branch/foo.cpp"],
    );
  });

  it("requires both source and target", () => {
    assert.throws(
      () => buildIntegrateArgs({ source: "", target: "//depot/branch/..." }),
      /Source path is required/,
    );
    assert.throws(
      () => buildIntegrateArgs({ source: "//depot/main/...", target: "" }),
      /Target path is required/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildMergeArgs / buildCopyArgs — share shape with integrate but use -F not -f
// ─────────────────────────────────────────────────────────────────────────

describe("buildMergeArgs", () => {
  it("builds plain merge between two paths", () => {
    assert.deepEqual(
      buildMergeArgs({ source: "//depot/main/...", target: "//depot/branch/..." }),
      ["merge", "//depot/main/...", "//depot/branch/..."],
    );
  });

  it("uses CAPITAL -F for force (NOT lowercase -f like integrate)", () => {
    const args = buildMergeArgs({
      source: "//depot/main/foo.cpp",
      target: "//depot/branch/foo.cpp",
      force: true,
    });
    assert.ok(args.includes("-F"), `expected -F in ${JSON.stringify(args)}`);
    assert.ok(!args.includes("-f"), `did NOT expect -f in ${JSON.stringify(args)}`);
  });

  it("supports preview + changelist + reverse together", () => {
    assert.deepEqual(
      buildMergeArgs({
        source: "//depot/main/...",
        target: "//depot/branch/...",
        preview: true,
        reverse: true,
        changelist: "33",
      }),
      ["merge", "-n", "-r", "-c", "33", "//depot/main/...", "//depot/branch/..."],
    );
  });

  it("requires both source and target", () => {
    assert.throws(() => buildMergeArgs({ source: "", target: "//depot/branch/..." }), /Source path is required/);
    assert.throws(() => buildMergeArgs({ source: "//depot/main/...", target: "" }), /Target path is required/);
  });
});

describe("buildCopyArgs", () => {
  it("builds plain copy between two paths", () => {
    assert.deepEqual(
      buildCopyArgs({ source: "//depot/main/...", target: "//depot/release/..." }),
      ["copy", "//depot/main/...", "//depot/release/..."],
    );
  });

  it("uses CAPITAL -F for force (NOT lowercase -f)", () => {
    const args = buildCopyArgs({
      source: "//depot/main/...",
      target: "//depot/release/...",
      force: true,
    });
    assert.ok(args.includes("-F"));
    assert.ok(!args.includes("-f"));
  });

  it("combines all flags in canonical order: -n -F -r -c", () => {
    assert.deepEqual(
      buildCopyArgs({
        source: "//depot/main/...",
        target: "//depot/release/...",
        preview: true,
        force: true,
        reverse: true,
        changelist: "44",
      }),
      ["copy", "-n", "-F", "-r", "-c", "44", "//depot/main/...", "//depot/release/..."],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// replaceDescriptionInSpec — round-trip with parseChangeSpecDescription
// ─────────────────────────────────────────────────────────────────────────

describe("replaceDescriptionInSpec", () => {
  const SPEC = `# A Perforce Change Specification.

Change: 12345

Client: my-client

User:\tme

Status: pending

Description:
\tOld description.
\tSecond line.

Type:\tpublic

Files:
\t//depot/main/foo.txt\t# edit
`;

  it("replaces the description body while preserving all other fields", () => {
    const updated = replaceDescriptionInSpec(SPEC, "New description.\n\nNew bullet.");
    // Other fields survive verbatim.
    assert.match(updated, /Change: 12345/);
    assert.match(updated, /Client: my-client/);
    assert.match(updated, /Status: pending/);
    assert.match(updated, /Type:\tpublic/);
    assert.match(updated, /Files:/);
    assert.match(updated, /\/\/depot\/main\/foo\.txt\t# edit/);
    // New description is present, tab-indented.
    assert.match(updated, /Description:\n\tNew description\.\n\t\n\tNew bullet\./);
    // Old description is gone.
    assert.doesNotMatch(updated, /Old description/);
  });

  it("round-trips: parse(replace(spec, X)) === normalize(X)", () => {
    const newDesc = "Round-trip me.\n\nWith a blank line.";
    const updated = replaceDescriptionInSpec(SPEC, newDesc);
    assert.equal(parseChangeSpecDescription(updated), normalizeDescription(newDesc));
  });

  it("rejects empty new descriptions", () => {
    assert.throws(
      () => replaceDescriptionInSpec(SPEC, "   \n\t  "),
      /Description must be non-empty/,
    );
  });

  it("throws if the spec is missing a Description: section", () => {
    const noDesc = `Change: 1\n\nFiles:\n\t//depot/a.txt\t# edit\n`;
    assert.throws(
      () => replaceDescriptionInSpec(noDesc, "anything"),
      /does not contain a 'Description:' section/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildReopenArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildReopenArgs", () => {
  it("builds args for moving opened files into a numbered changelist", () => {
    assert.deepEqual(
      buildReopenArgs({
        changelist: "12345",
        files: ["//depot/a.cpp", "//depot/b.cpp"],
      }),
      ["reopen", "-c", "12345", "//depot/a.cpp", "//depot/b.cpp"],
    );
  });

  it("supports moving opened files back to the default changelist", () => {
    assert.deepEqual(
      buildReopenArgs({ changelist: "default", files: ["//depot/a.cpp"] }),
      ["reopen", "-c", "default", "//depot/a.cpp"],
    );
  });

  it("rejects empty file lists", () => {
    assert.throws(
      () => buildReopenArgs({ changelist: "12345", files: [] }),
      /At least one file path is required/,
    );
  });

  it("retypes opened files without moving them (filetype only, no changelist)", () => {
    assert.deepEqual(
      buildReopenArgs({ filetype: "binary+l", files: ["//depot/a.uasset"] }),
      ["reopen", "-t", "binary+l", "//depot/a.uasset"],
    );
  });

  it("moves and retypes in one call (changelist + filetype)", () => {
    assert.deepEqual(
      buildReopenArgs({ changelist: "9", filetype: "text+w", files: ["//depot/a.cpp"] }),
      ["reopen", "-c", "9", "-t", "text+w", "//depot/a.cpp"],
    );
  });

  it("requires at least one of changelist or filetype", () => {
    assert.throws(
      () => buildReopenArgs({ files: ["//depot/a.cpp"] }),
      /at least one of changelist or filetype/i,
    );
  });

  it("rejects malicious filetype containing flag-like characters", () => {
    assert.throws(
      () => buildReopenArgs({ filetype: "-d -rf", files: ["x.txt"] }),
      /Invalid filetype/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildMoveArgs
// ─────────────────────────────────────────────────────────────────────────

describe("buildMoveArgs", () => {
  it("builds preview args for moving a file in a numbered changelist", () => {
    assert.deepEqual(
      buildMoveArgs({
        source: "//depot/old.cpp",
        target: "//depot/new.cpp",
        changelist: "12345",
        preview: true,
      }),
      ["move", "-n", "-c", "12345", "//depot/old.cpp", "//depot/new.cpp"],
    );
  });

  it("omits -c when moving in the default changelist", () => {
    assert.deepEqual(
      buildMoveArgs({
        source: "//depot/old.cpp",
        target: "//depot/new.cpp",
        changelist: "default",
      }),
      ["move", "//depot/old.cpp", "//depot/new.cpp"],
    );
  });

  it("adds recursive rename mode when requested", () => {
    assert.deepEqual(
      buildMoveArgs({
        source: "//depot/old/...",
        target: "//depot/new/...",
        recursive: true,
        preview: true,
      }),
      ["move", "-n", "-r", "//depot/old/...", "//depot/new/..."],
    );
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

// ─────────────────────────────────────────────────────────────────────────
// buildChangesArgs — unifies `p4 changes` queries (absorbs the old
// p4_changelists). Pure: defaultUser + depotRoot are passed in.
// ─────────────────────────────────────────────────────────────────────────

describe("buildChangesArgs", () => {
  const depotRoot = "//Depot/...";

  it("defaults to recent submitted changes by the configured user", () => {
    assert.deepEqual(
      buildChangesArgs({ defaultUser: "me", depotRoot }),
      ["changes", "-s", "submitted", "-u", "me", "-m", "10", "//Depot/..."],
    );
  });

  it("client scope lists pending workspace changes without forcing the user filter", () => {
    // This is the old p4_changelists behavior: pending changes in a client
    // workspace, any user. No -u must be emitted.
    assert.deepEqual(
      buildChangesArgs({ status: "pending", client: "ws1", defaultUser: "me", depotRoot }),
      ["changes", "-s", "pending", "-c", "ws1", "-m", "10", "//Depot/..."],
    );
  });

  it("explicit user overrides the configured default", () => {
    assert.deepEqual(
      buildChangesArgs({ user: "bob", defaultUser: "me", depotRoot }),
      ["changes", "-s", "submitted", "-u", "bob", "-m", "10", "//Depot/..."],
    );
  });

  it("user and client combine into an intersection filter", () => {
    assert.deepEqual(
      buildChangesArgs({ user: "bob", client: "ws1", status: "pending", defaultUser: "me", depotRoot }),
      ["changes", "-s", "pending", "-u", "bob", "-c", "ws1", "-m", "10", "//Depot/..."],
    );
  });

  it("respects a custom max", () => {
    assert.deepEqual(
      buildChangesArgs({ max: 50, defaultUser: "me", depotRoot }),
      ["changes", "-s", "submitted", "-u", "me", "-m", "50", "//Depot/..."],
    );
  });
});
