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

export function parseCreatedChangelist(output) {
  const m = output.match(/Change (\d+) created\./);
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

function validateChangelist(changelist, { allowDefault = true } = {}) {
  const cl = String(changelist || "").trim();
  if (allowDefault && cl === "default") return cl;
  if (/^\d+$/.test(cl)) return cl;
  const expected = allowDefault ? "a numeric changelist or 'default'" : "a numeric changelist";
  throw new Error(`Invalid changelist '${cl}'. Must be ${expected}.`);
}

function normalizeFileList(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one file path is required.");
  }
  const normalized = files.map((file) => String(file || "").trim());
  if (normalized.some((file) => file.length === 0)) {
    throw new Error("File paths must be non-empty strings.");
  }
  return normalized;
}

function validatePath(value, label) {
  const path = String(value || "").trim();
  if (path.length === 0) throw new Error(`${label} path is required.`);
  return path;
}

export function buildCreateChangeSpec({ client, description }) {
  const clientName = String(client || "").trim();
  if (clientName.length === 0) throw new Error("Client is required.");
  const desc = normalizeDescription(description || "");
  if (desc.length === 0) throw new Error("Description must be non-empty.");
  const descLines = desc.split("\n").map((line) => `\t${line}`);
  return [
    "Change: new",
    `Client: ${clientName}`,
    "",
    "Description:",
    ...descLines,
    "",
  ].join("\n");
}

export function buildReopenArgs({ changelist, files }) {
  const cl = validateChangelist(changelist);
  return ["reopen", "-c", cl, ...normalizeFileList(files)];
}

export function buildEditArgs({ files, changelist = undefined, preview = false }) {
  const args = ["edit"];
  if (preview) args.push("-n");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  return [...args, ...normalizeFileList(files)];
}

// Validates a filetype string like "text", "binary", "text+w", "binary+l", "+S2".
// Perforce filetypes are base-type + optional + modifier chars. Restricting the
// charset prevents injection of additional p4 flags via the -t argument.
function validateFiletype(filetype) {
  const ft = String(filetype || "").trim();
  if (ft.length === 0) throw new Error("filetype must be non-empty when provided.");
  if (!/^\+?[a-zA-Z0-9+]+$/.test(ft)) {
    throw new Error(
      `Invalid filetype '${ft}'. Allowed: base types (text, binary, symlink, etc.) plus '+' modifiers.`,
    );
  }
  return ft;
}

export function buildRevertArgs({ files, changelist = undefined, preview = false, keepWorkspaceFile = false, unchangedOnly = false }) {
  const args = ["revert"];
  if (preview) args.push("-n");
  if (keepWorkspaceFile) args.push("-k");
  if (unchangedOnly) args.push("-a");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  return [...args, ...normalizeFileList(files)];
}

export function buildLockArgs({ files, changelist = undefined }) {
  const args = ["lock"];
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  return [...args, ...normalizeFileList(files)];
}

export function buildUnlockArgs({ files, changelist = undefined }) {
  const args = ["unlock"];
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  return [...args, ...normalizeFileList(files)];
}

export function buildAddArgs({ files, changelist = undefined, preview = false, filetype = undefined }) {
  const args = ["add"];
  if (preview) args.push("-n");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  if (filetype !== undefined && filetype !== null && filetype !== "") {
    args.push("-t", validateFiletype(filetype));
  }
  return [...args, ...normalizeFileList(files)];
}

export function buildDeleteArgs({ files, changelist = undefined, preview = false, keepWorkspaceFile = false }) {
  const args = ["delete"];
  if (preview) args.push("-n");
  if (keepWorkspaceFile) args.push("-k");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  return [...args, ...normalizeFileList(files)];
}

export function buildShelveArgs({ changelist, files = undefined, replace = false }) {
  const cl = validateChangelist(changelist, { allowDefault: false });
  const args = ["shelve"];
  if (replace) args.push("-r", "-f");
  args.push("-c", cl);
  if (files !== undefined && files !== null) {
    args.push(...normalizeFileList(files));
  }
  return args;
}

export function buildUnshelveArgs({ sourceChangelist, targetChangelist = undefined, files = undefined, preview = false }) {
  const source = validateChangelist(sourceChangelist, { allowDefault: false });
  const args = ["unshelve", "-s", source];
  if (preview) args.push("-n");
  if (targetChangelist !== undefined && targetChangelist !== null && targetChangelist !== "") {
    const target = validateChangelist(targetChangelist);
    if (target !== "default") args.push("-c", target);
  }
  if (files !== undefined && files !== null) {
    args.push(...normalizeFileList(files));
  }
  return args;
}

export function buildIntegrateArgs({ source, target, changelist = undefined, preview = false, force = false, reverse = false }) {
  const args = ["integrate"];
  if (preview) args.push("-n");
  if (force) args.push("-f");
  if (reverse) args.push("-r");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  args.push(validatePath(source, "Source"), validatePath(target, "Target"));
  return args;
}

// p4 merge: friendlier integrate with merge-biased defaults. Note the force
// flag is `-F` (capital), distinct from integrate's `-f`. Kept as a separate
// builder rather than DRY'd with integrate so the divergent flag letter is
// visible at every call site.
export function buildMergeArgs({ source, target, changelist = undefined, preview = false, force = false, reverse = false }) {
  const args = ["merge"];
  if (preview) args.push("-n");
  if (force) args.push("-F");
  if (reverse) args.push("-r");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  args.push(validatePath(source, "Source"), validatePath(target, "Target"));
  return args;
}

// p4 copy: stamps source onto target verbatim — no content merging. Force
// flag is `-F` (capital). Used for release-promotion / branch-sync flows
// where you want target to become a byte-identical copy of source.
export function buildCopyArgs({ source, target, changelist = undefined, preview = false, force = false, reverse = false }) {
  const args = ["copy"];
  if (preview) args.push("-n");
  if (force) args.push("-F");
  if (reverse) args.push("-r");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  args.push(validatePath(source, "Source"), validatePath(target, "Target"));
  return args;
}

// Rewrites the Description: block of an existing change spec while preserving
// every other field (Files, Jobs, Type, Client, User, Status, etc.) verbatim.
// This is the inverse of parseChangeSpecDescription — same terminator semantics
// (next un-indented section header ends the description block).
//
// Why a surgical rewrite vs. rebuilding the spec: callers may have populated
// Type:, Jobs:, or moved Files: into the CL via other tools; rebuilding from
// scratch would drop those. The rewrite preserves them.
export function replaceDescriptionInSpec(spec, newDescription) {
  const desc = normalizeDescription(newDescription || "");
  if (desc.length === 0) throw new Error("Description must be non-empty.");
  const descLines = desc.split("\n").map((line) => `\t${line}`);

  const lines = spec.split(/\r?\n/);
  const out = [];
  let i = 0;
  let found = false;

  while (i < lines.length) {
    out.push(lines[i]);
    if (/^Description:\s*$/.test(lines[i])) {
      found = true;
      i++;
      break;
    }
    i++;
  }

  if (!found) {
    throw new Error("Change spec does not contain a 'Description:' section.");
  }

  // Skip the existing description body — every line up to (but not including)
  // the next un-indented section header.
  while (i < lines.length && !/^[A-Z][a-zA-Z]*:/.test(lines[i])) {
    i++;
  }

  out.push(...descLines);

  if (i < lines.length) {
    out.push("");
    while (i < lines.length) {
      out.push(lines[i]);
      i++;
    }
  } else {
    out.push("");
  }

  return out.join("\n");
}

export function buildMoveArgs({ source, target, changelist = undefined, preview = false, recursive = false }) {
  const args = ["move"];
  if (preview) args.push("-n");
  if (recursive) args.push("-r");
  if (changelist !== undefined && changelist !== null && changelist !== "") {
    const cl = validateChangelist(changelist);
    if (cl !== "default") args.push("-c", cl);
  }
  args.push(validatePath(source, "Source"), validatePath(target, "Target"));
  return args;
}
