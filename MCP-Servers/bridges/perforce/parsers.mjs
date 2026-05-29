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

// p4 reopen has two independent facets: -c <changelist> moves opened files
// between pending CLs, and -t <filetype> retypes them (e.g. flipping an asset
// to binary+l). Either or both may be supplied; at least one is required —
// `p4 reopen <files>` with no flag is a no-op the caller never wants.
export function buildReopenArgs({ changelist = undefined, filetype = undefined, files }) {
  const hasChangelist = changelist !== undefined && changelist !== null && changelist !== "";
  const hasFiletype = filetype !== undefined && filetype !== null && filetype !== "";
  if (!hasChangelist && !hasFiletype) {
    throw new Error("Reopen requires at least one of changelist or filetype.");
  }
  const args = ["reopen"];
  if (hasChangelist) args.push("-c", validateChangelist(changelist));
  if (hasFiletype) args.push("-t", validateFiletype(filetype));
  return [...args, ...normalizeFileList(files)];
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

// Unifies `p4 changes` queries. Absorbs the old p4_changelists tool: a bare
// call lists the configured user's recent submitted changes ("my changes"),
// while passing `client` lists changes scoped to a workspace. defaultUser and
// depotRoot are injected (keeps this module dependency-free).
//
// User-filter rule: an explicit `user` always wins. With no user, we only fall
// back to defaultUser when no `client` is given either — so `client`-scoped
// queries list changes by ANY user in that workspace (the old p4_changelists
// semantics), not just the configured one.
export function buildChangesArgs({ status = "submitted", max = 10, user = undefined, client = undefined, defaultUser, depotRoot }) {
  const hasUser = user !== undefined && user !== null && user !== "";
  const hasClient = client !== undefined && client !== null && client !== "";
  const args = ["changes", "-s", status];
  if (hasUser) {
    args.push("-u", user);
  } else if (!hasClient) {
    args.push("-u", defaultUser);
  }
  if (hasClient) args.push("-c", client);
  args.push("-m", String(max), depotRoot);
  return args;
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

// ───────────────────────────────────────────────────────────────────────
// Admin / identity tier (Phase 1, read-only). See
// _handoffs/2026-05-29-perforce-admin-tier.md. These commands report on the
// whole Perforce server, not //P4DEPOT/... — callers wrap results with a
// `scope: "server-global"` field per the scope-leak audit convention.
// ───────────────────────────────────────────────────────────────────────

// Guard a Perforce user/group identifier. Rejects empty strings and anything
// starting with '-' so a caller-supplied name can never be parsed by p4 as a
// flag (e.g. a "user" named "-d"). Perforce names don't contain whitespace.
function validateName(value, label) {
  const name = String(value ?? "").trim();
  if (name.length === 0) throw new Error(`${label} is required.`);
  if (name.startsWith("-")) throw new Error(`Invalid ${label} '${name}': must not start with '-'.`);
  if (/\s/.test(name)) throw new Error(`Invalid ${label} '${name}': must not contain whitespace.`);
  return name;
}

// `p4 users [user...]` — one record per line:
//   <user> <email> (<Full Name>) accessed YYYY/MM/DD HH:MM:SS
// Email and full name can be absent on sparse/service accounts, so each field
// is matched independently rather than as one rigid line pattern.
export function parseUsersOutput(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const user = line.split(/\s+/)[0] || null;
      const emailMatch = line.match(/<([^>]*)>/);
      const fullNameMatch = line.match(/\(([^)]*)\)/);
      const accessedMatch = line.match(/accessed\s+(\d{4}\/\d{2}\/\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)/);
      return {
        user,
        email: emailMatch ? emailMatch[1] : null,
        fullName: fullNameMatch ? fullNameMatch[1] : null,
        lastAccess: accessedMatch ? accessedMatch[1] : null,
      };
    });
}

// `p4 groups [user]` prints one group name per line.
export function parseGroupsOutput(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Parse a `p4 group -o <name>` form spec. Reuses the same tab-indented-block
// rules as parseChangeSpecDescription: a section header is an un-indented
// "Word:" line; its body is the tab-indented lines beneath it. List sections
// (Users/Owners/Subgroups) collect their indented members; scalar sections
// (Timeout/MaxResults/…) take the inline value after the colon. Numeric limit
// fields are left as their raw string ('unset' vs a number) so a future writer
// can distinguish "no limit imposed" from a real value.
export function parseGroupSpec(text) {
  const lines = String(text || "").split(/\r?\n/);
  const scalars = {
    Group: "group",
    Timeout: "timeout",
    PasswordTimeout: "passwordTimeout",
    MaxResults: "maxResults",
    MaxScanRows: "maxScanRows",
    MaxLockTime: "maxLockTime",
    MaxOpenFiles: "maxOpenFiles",
  };
  const lists = { Users: "users", Owners: "owners", Subgroups: "subgroups" };
  const out = { group: null, timeout: null, maxResults: null, maxScanRows: null, maxLockTime: null, users: [], owners: [], subgroups: [] };

  let currentList = null;
  for (const line of lines) {
    if (/^#/.test(line) || line.trim() === "") continue;
    const headerMatch = line.match(/^([A-Za-z][A-Za-z]*):\s*(.*)$/);
    if (headerMatch && !line.startsWith("\t")) {
      const [, header, inline] = headerMatch;
      if (Object.prototype.hasOwnProperty.call(scalars, header)) {
        currentList = null;
        const value = inline.trim();
        out[scalars[header]] = value.length ? value : null;
      } else if (Object.prototype.hasOwnProperty.call(lists, header)) {
        currentList = lists[header];
        // A member can appear inline on the header line (rare) or below it.
        if (inline.trim().length) out[currentList].push(inline.trim());
      } else {
        currentList = null;
      }
      continue;
    }
    // Indented continuation line → a member of the current list section.
    if (currentList && line.startsWith("\t")) {
      const member = line.trim();
      if (member.length) out[currentList].push(member);
    }
  }
  return out;
}

// `p4 login -s` reports ticket state. Valid:
//   "User <u> ticket expires in NNN hours MM minutes."  (or "NNN seconds.")
// Unlimited-timeout groups can yield a very large value; an expired or
// absent ticket comes back as an error string we classify rather than throw on.
export function parseLoginStatus(text) {
  const raw = String(text || "").trim();
  const userMatch = raw.match(/User\s+(\S+)\s+ticket/);
  const user = userMatch ? userMatch[1] : null;

  if (/expired|invalid or unset|not logged in|Perforce password/i.test(raw)) {
    return { user, status: "expired", expiresInSeconds: null, raw };
  }

  // Sum any "N hours", "M minutes", "S seconds" present after "expires in".
  const expiresMatch = raw.match(/expires in (.+?)\.?$/i);
  if (expiresMatch) {
    const span = expiresMatch[1];
    const hours = Number((span.match(/(\d+)\s*hours?/i) || [])[1] || 0);
    const minutes = Number((span.match(/(\d+)\s*minutes?/i) || [])[1] || 0);
    const seconds = Number((span.match(/(\d+)\s*seconds?/i) || [])[1] || 0);
    const total = hours * 3600 + minutes * 60 + seconds;
    return { user, status: "valid", expiresInSeconds: total || null, raw };
  }

  return { user, status: "unknown", expiresInSeconds: null, raw };
}

// `p4 protects -m` prints a single bare access-level token. Returns the
// recognized level, or null if the output isn't one (e.g. an error).
const PROTECT_LEVELS = ["super", "admin", "write", "open", "read", "list"];
export function parseProtectsMax(text) {
  const token = String(text || "").trim().toLowerCase();
  return PROTECT_LEVELS.includes(token) ? token : null;
}

export function buildUsersArgs({ user = undefined } = {}) {
  const args = ["users"];
  const names = user === undefined || user === null ? [] : Array.isArray(user) ? user : [user];
  for (const n of names) args.push(validateName(n, "user"));
  return args;
}

export function buildGroupsArgs({ user = undefined } = {}) {
  const args = ["groups"];
  if (user !== undefined && user !== null && user !== "") args.push(validateName(user, "user"));
  return args;
}

export function buildGroupInfoArgs({ group }) {
  return ["group", "-o", validateName(group, "group")];
}

export function buildLoginStatusArgs({ user = undefined } = {}) {
  const args = ["login", "-s"];
  if (user !== undefined && user !== null && user !== "") args.push(validateName(user, "user"));
  return args;
}

export function buildProtectsArgs({ max = false, user = undefined } = {}) {
  const args = ["protects"];
  if (max) args.push("-m");
  if (user !== undefined && user !== null && user !== "") args.push("-u", validateName(user, "user"));
  return args;
}

// ───────────────────────────────────────────────────────────────────────
// Admin / identity tier (Phase 2, WRITE). Gated behind P4_ENABLE_ADMIN and a
// runtime `super` capability pre-check in the server. These mutate
// server-global state. See _handoffs/2026-05-29-perforce-admin-tier.md.
// ───────────────────────────────────────────────────────────────────────

// A group Timeout is one of: 'unlimited', 'unset', or a positive integer
// (seconds). Returned as a normalized string for direct substitution into a
// spec. Rejects anything else so a typo can't write a garbage spec.
export function validateGroupTimeout(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "unlimited" || v === "unset") return v;
  if (/^\d+$/.test(v)) {
    if (Number(v) <= 0) throw new Error(`Invalid timeout '${value}': seconds must be a positive integer.`);
    return v;
  }
  throw new Error(`Invalid timeout '${value}': expected 'unlimited', 'unset', or a positive integer (seconds).`);
}

// Read-modify-write a `p4 group -o` spec. Only the provided fields are touched;
// every other line (MaxResults/MaxScanRows/MaxLockTime, comments, etc.) is
// preserved verbatim. `timeout` is a scalar replace; `users`/`owners`/
// `subgroups` replace the entire membership of their section. This is safer
// than serializing a spec from scratch — unspecified server-managed fields
// can't be accidentally cleared or capped.
export function applyGroupSpecChanges(specText, { timeout, users, owners, subgroups } = {}) {
  let lines = String(specText || "").split(/\r?\n/);

  if (timeout !== undefined && timeout !== null && timeout !== "") {
    const normalized = validateGroupTimeout(timeout);
    lines = replaceScalarField(lines, "Timeout", normalized);
  }
  const listEdits = [
    ["Users", users],
    ["Owners", owners],
    ["Subgroups", subgroups],
  ];
  for (const [header, members] of listEdits) {
    if (members !== undefined && members !== null) {
      if (!Array.isArray(members)) throw new Error(`${header} must be an array of names.`);
      const validated = members.map((m) => validateName(m, header.replace(/s$/, "").toLowerCase()));
      lines = replaceListSection(lines, header, validated);
    }
  }
  return lines.join("\n");
}

// Replace the inline value of an un-indented "Header:\tvalue" line. If the
// field is absent, appends it (p4 group templates always include Timeout, but
// this keeps the helper general).
function replaceScalarField(lines, header, value) {
  const re = new RegExp(`^${header}:`);
  const out = [];
  let replaced = false;
  for (const line of lines) {
    if (!replaced && re.test(line) && !line.startsWith("\t")) {
      out.push(`${header}:\t${value}`);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  if (!replaced) out.push(`${header}:\t${value}`);
  return out;
}

// Replace an entire list section's members. Drops the old tab-indented body
// after the "Header:" line (up to the next un-indented section header) and
// writes the new members. Appends the section if absent.
function replaceListSection(lines, header, members) {
  const re = new RegExp(`^${header}:`);
  const out = [];
  let i = 0;
  let handled = false;
  while (i < lines.length) {
    if (!handled && re.test(lines[i]) && !lines[i].startsWith("\t")) {
      out.push(`${header}:`);
      for (const m of members) out.push(`\t${m}`);
      i++;
      // Skip the existing indented body (and the blank lines within it).
      while (i < lines.length && (lines[i].startsWith("\t") || lines[i].trim() === "")) {
        // Stop if a blank line is immediately followed by a new section header,
        // so we don't swallow the separator before the next section.
        if (lines[i].trim() === "") {
          const next = lines[i + 1];
          if (next === undefined || (/^[A-Za-z][A-Za-z]*:/.test(next) && !next.startsWith("\t"))) break;
        }
        i++;
      }
      handled = true;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  if (!handled) {
    out.push(`${header}:`);
    for (const m of members) out.push(`\t${m}`);
  }
  return out;
}
