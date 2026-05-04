#!/usr/bin/env node
// install.mjs - central orchestrator for the AI-Tools MCP bridge installer.
//
// This script is the brains. install.bat / install.ps1 are GUI thin wrappers
// that gather workspace path via Windows dialogs and invoke this script with
// flags. Running this script directly from a TTY also works.
//
// Modes:
//   install      (default) interactive setup for a workspace
//   --doctor     read-only health check of the workspace
//   --update     force a GitHub update check + cache refresh
//   --bridges=a,b  non-interactive selection
//   --workspace=PATH  override workspace (default: cwd)
//   --enable-update-checks   write a CCD SessionStart hook for daily nudges
//
// Repo: https://github.com/noahbutcher97/AI-Tools

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { spawnSync } from "child_process";

import { safePath, safeJoin } from "./lib/safepath.mjs";
import {
  ask, askSecret, confirm, multiSelect, openInBrowser,
  printSection, printStep, printInfo, printOk, printErr, printWarn,
} from "./lib/prompts.mjs";
import {
  loadWorkspaceConfig,
  setBridgeInConfig,
  disableBridgeInConfig,
  writeWorkspaceConfig,
  ensureSecretIgnored,
  PUBLIC_FILE,
  SECRET_FILE,
} from "./lib/mcp-config.mjs";
import { getLatestRelease, downloadToBuffer } from "./lib/github.mjs";
import { isCheckRateLimited, writeLastCheck, readLastCheck, bridgeVersionDir } from "./lib/cache.mjs";

// ───────────────────────────────────────────────────────────────────────
// Locate ourselves + locate the MCP-Servers tree
// ───────────────────────────────────────────────────────────────────────
// Layout: <ai-tools-root>/Installers/MCP-Suite/install.mjs (this file)
//         <ai-tools-root>/MCP-Servers/manifest.json + bridges/
//
// Override with MCP_SERVERS_ROOT env var if the layout differs.
// Otherwise, walk up looking for a sibling MCP-Servers/ directory.

const __dirname = dirname(fileURLToPath(import.meta.url));

function findMcpServersRoot(startDir) {
  // Inputs: MCP_SERVERS_ROOT env (user's own env, validated via safePath)
  // or startDir (this script's own __dirname — not external input).
  // Single-user dev tool; CWE-22 attack vector doesn't apply here.
  if (process.env.MCP_SERVERS_ROOT) {
    return safePath(process.env.MCP_SERVERS_ROOT, { label: "MCP_SERVERS_ROOT" });
  }
  // nosemgrep
  let dir = resolve(startDir);
  // nosemgrep
  const root = resolve("/");
  while (dir !== root) {
    // nosemgrep
    const candidate = safeJoin(dir, "MCP-Servers", "manifest.json");
    // nosemgrep
    if (existsSync(candidate)) return safeJoin(dir, "MCP-Servers");
    // nosemgrep
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume default layout (Installers/<name>/ -> ../../MCP-Servers)
  // nosemgrep
  return resolve(startDir, "..", "..", "MCP-Servers");
}

const MCP_SERVERS_ROOT = findMcpServersRoot(__dirname);
const ROOT_MANIFEST_PATH = safeJoin(MCP_SERVERS_ROOT, "manifest.json");

function loadRootManifest() {
  if (!existsSync(ROOT_MANIFEST_PATH)) {
    console.error(`Root manifest.json not found at ${ROOT_MANIFEST_PATH}`);
    console.error(`Set MCP_SERVERS_ROOT env var or run from inside an AI-Tools checkout.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(ROOT_MANIFEST_PATH, "utf-8"));
}

// ───────────────────────────────────────────────────────────────────────
// CLI args
// ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: "install",
    workspace: null,
    bridges: null,
    update: false,
    enableUpdateChecks: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--doctor") args.mode = "doctor";
    else if (a === "--update") args.update = true;
    else if (a === "--enable-update-checks") args.enableUpdateChecks = true;
    else if (a.startsWith("--workspace=")) args.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--bridges=")) {
      args.bridges = a
        .slice("--bridges=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
AI-Tools MCP Bridge Installer

Usage: node install.mjs [options]

Options:
  --workspace=PATH         Workspace dir (default: current directory)
  --bridges=NAMES          Comma-separated bridges to enable (skips menu)
  --doctor                 Inspect workspace config; no prompts
  --update                 Force GitHub update check
  --enable-update-checks   Add a daily update-nudge to CCD SessionStart hook
  --help                   Show this help
`);
}

// ───────────────────────────────────────────────────────────────────────
// Update check (non-blocking, throttled to once per 24h)
// ───────────────────────────────────────────────────────────────────────

async function maybeCheckForUpdates(rootManifest, force) {
  const repo = parseRepoFromHomepage(rootManifest.homepage);
  if (!repo) return;

  if (!force && isCheckRateLimited(repo)) {
    return;
  }

  try {
    const latest = await getLatestRelease(repo);
    writeLastCheck(repo, { tag: latest?.tag || null });
    if (!latest) return;
    if (latest.tag && latest.tag !== `v${rootManifest.version}` && latest.tag !== rootManifest.version) {
      console.log(`\n  >> Update available: ${latest.tag} (you have v${rootManifest.version})`);
      console.log(`     https://github.com/${repo}/releases/latest`);
      console.log(`     Run install.bat --update to refresh.\n`);
    }
  } catch (e) {
    // Update check is best-effort — never fail the install over it.
    if (force) console.error(`Update check failed: ${e.message}`);
  }
}

function parseRepoFromHomepage(homepage) {
  if (!homepage) return null;
  const m = /github\.com\/([^/]+\/[^/]+)/.exec(homepage);
  return m ? m[1] : null;
}

// ───────────────────────────────────────────────────────────────────────
// Bridge source resolution (co-located vs remote-repo)
// ───────────────────────────────────────────────────────────────────────

function bridgeSourceDir(bridgeEntry, bridgeName) {
  const src = bridgeEntry.source;
  if (!src) throw new Error(`Bridge '${bridgeName}' missing source declaration`);
  if (src.type === "co-located") {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
    return safeJoin(MCP_SERVERS_ROOT, src.path);
  }
  if (src.type === "remote-repo") {
    // Returned path may not exist yet — caller fetches if needed
    return bridgeVersionDir(bridgeName, "remote");
  }
  throw new Error(`Bridge '${bridgeName}' has unsupported source.type: ${src.type}`);
}

async function ensureBridgeAvailable(bridgeEntry, bridgeName) {
  const src = bridgeEntry.source;
  if (src.type === "co-located") {
    const dir = bridgeSourceDir(bridgeEntry, bridgeName);
    if (!existsSync(dir)) throw new Error(`Co-located bridge missing on disk: ${dir}`);
    return dir;
  }
  if (src.type === "remote-repo") {
    const dir = bridgeVersionDir(bridgeName, "remote");
    if (existsSync(safeJoin(dir, "manifest.json"))) {
      return dir; // already cached
    }
    console.log(`  Downloading ${bridgeName} from github.com/${src.repo}...`);
    await fetchRemoteBridge(src, dir);
    return dir;
  }
  throw new Error(`Unsupported source type for ${bridgeName}`);
}

async function fetchRemoteBridge(src, targetDir) {
  // Use GitHub's tarball endpoint via downloadToBuffer + tar via Node
  const release = await getLatestRelease(src.repo);
  const url = release?.tarballUrl || `https://api.github.com/repos/${src.repo}/tarball/HEAD`;
  const buf = await downloadToBuffer(url);
  mkdirSync(targetDir, { recursive: true });

  // Extract via system `tar` (available on Win10+). Write the tarball to
  // a temp file then extract. Simpler than implementing tar in JS.
  const tmpFile = safeJoin(targetDir, "_download.tar.gz");
  writeFileSync(tmpFile, buf);
  const r = spawnSync("tar", ["-xzf", tmpFile, "-C", targetDir, "--strip-components=1"], {
    encoding: "utf-8",
    timeout: 120000,
  });
  if (r.status !== 0) {
    throw new Error(`tar extraction failed: ${r.stderr || r.stdout}`);
  }
  try {
    unlinkSync(tmpFile);
  } catch { /* ignore */ }
}

// ───────────────────────────────────────────────────────────────────────
// Bridge manifest loading + auto-detect helpers
// ───────────────────────────────────────────────────────────────────────

function loadBridgeManifest(bridgeDir) {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
  const path = safeJoin(bridgeDir, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`Bridge manifest.json not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function autoDetect(bridgeManifest, workspaceDir) {
  const ad = bridgeManifest.autoDetect;
  if (!ad) return {};
  if (ad.type === "p4config") {
    return detectP4Config(workspaceDir, ad.files || [".p4config"]);
  }
  if (ad.type === "uproject") {
    return detectUproject(workspaceDir);
  }
  return {};
}

function detectP4Config(workspaceDir, files) {
  const out = {};
  for (const fname of files) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
    const path = safeJoin(workspaceDir, fname);
    if (!existsSync(path)) continue;
    try {
      const lines = readFileSync(path, "utf-8").split(/\r?\n/);
      for (const line of lines) {
        const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const [, key, value] = m;
        if (value === "" || value.startsWith("#")) continue;
        if (out[key] === undefined) out[key] = value;
      }
    } catch { /* ignore */ }
  }
  return out;
}

function detectUproject(workspaceDir) {
  const stack = [workspaceDir];
  // BFS shallow scan: workspace + 1 level of subdirs
  for (let depth = 0; depth < 2 && stack.length > 0; depth++) {
    const next = [];
    for (const dir of stack) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".uproject")) {
            return {
              UNREAL_PROJECT_ROOT: dir.replace(/\\/g, "/"),
              UNREAL_PROJECT_NAME: entry.name.replace(/\.uproject$/, ""),
            };
          }
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
            next.push(safeJoin(dir, entry.name));
          }
        }
      } catch { /* ignore */ }
    }
    stack.length = 0;
    stack.push(...next);
  }
  return {};
}

function detectGitEmail() {
  const r = spawnSync("git", ["config", "--get", "user.email"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  let raw = (r.stdout || "").trim();
  // Strip surrounding quotes (some shells / git configs include them literally)
  raw = raw.replace(/^['"]+|['"]+$/g, "").trim();
  return raw || null;
}

// Normalize a value before use: trim whitespace + strip surrounding quotes.
// Saved configs may have stray quotes from a previous install run (e.g.,
// when git config returned its value quoted). Always normalize on read so
// historical pollution is cleaned automatically.
function normalizeValue(value) {
  if (typeof value !== "string") return value;
  return value.trim().replace(/^['"]+|['"]+$/g, "").trim();
}

// ───────────────────────────────────────────────────────────────────────
// Credential flow per bridge
// ───────────────────────────────────────────────────────────────────────

async function gatherCredentials(bridgeManifest, autoDetected, existingPublic, existingSecrets) {
  const publicValues = {};
  const secretValues = {};

  for (const field of bridgeManifest.fields) {
    // Resolve the best-guess current value AND identify its source so we
    // can label it accurately. (Auto-detected != saved-existing!)
    // ALL values are normalized (trim + strip surrounding quotes) before use,
    // because a previous install run may have saved a noisy value.
    let value = undefined;
    let source = "";

    if (existingSecrets[field.name] !== undefined && existingSecrets[field.name] !== "") {
      value = normalizeValue(existingSecrets[field.name]);
      source = "saved";
    } else if (existingPublic[field.name] !== undefined && existingPublic[field.name] !== "") {
      value = normalizeValue(existingPublic[field.name]);
      source = "saved";
    } else if (autoDetected[field.name] !== undefined && autoDetected[field.name] !== "") {
      value = normalizeValue(autoDetected[field.name]);
      source = "auto-detected";
    } else if (field.autoDetect === "git-config-email") {
      const email = detectGitEmail();
      if (email) {
        value = normalizeValue(email);
        source = "from git config user.email";
      }
    } else if (field.default !== undefined && field.default !== "") {
      value = normalizeValue(field.default);
      source = "default";
    }

    // Section header for the field (consistent across bridges)
    printStep(field.label + (field.required ? " (required)" : " (optional)"));
    if (field.instructions && field.instructions.length > 0) {
      for (const line of field.instructions) printInfo(line);
    }

    // Show the suggested value (if any) so user knows what they'd be accepting.
    // Source label tells them where it came from so they can decide.
    if (value !== undefined && value !== "") {
      const display = field.secret ? `<${String(value).length} chars hidden>` : value;
      printInfo(`Current value (${source}): ${display}`);
    }

    // If this field has an associated URL (token-creation page, etc.), offer
    // to open it. Default to YES when there's no existing/detected value
    // (user probably needs to acquire one); default to NO if we already have
    // a value (user can press Enter to keep, doesn't need a new token).
    if (field.openUrl) {
      const defaultOpen = !(value !== undefined && value !== "");
      const wantOpen = await confirm(`  Open ${field.openUrl} in browser?`, defaultOpen);
      if (wantOpen) {
        const ok = openInBrowser(field.openUrl);
        if (!ok) printWarn(`Could not auto-open. Visit manually: ${field.openUrl}`);
      }
    }

    // Prompt for the value. Press Enter to accept the shown default,
    // type to override. (Validation failure triggers the retry loop in
    // runInstall — see below — which carries forward what was entered
    // so user only re-types the bits that need fixing.)
    let entered;
    if (field.secret) {
      const hint = value !== undefined && value !== ""
        ? "press Enter to keep current, or paste a new value"
        : "paste value (or press Enter to skip if optional)";
      entered = await askSecret(`  ${hint}`);
      if (entered === "" && value !== undefined && value !== "") {
        entered = value; // keep existing
      }
    } else {
      const fallback = value !== undefined && value !== "" ? value : (field.examplePlaceholder || "");
      entered = await ask(`  ${field.label}`, fallback);
    }

    // Validate non-empty for required fields
    if ((entered === undefined || entered === "") && field.required) {
      printErr(`${field.name} is required.`);
      const retry = field.secret
        ? await askSecret(`  ${field.label} (required, paste value)`)
        : await ask(`  ${field.label} (required)`, "");
      if (!retry) {
        throw new Error(`Required field ${field.name} not provided`);
      }
      entered = retry;
    }

    // Empty optional field: skip storing
    if (entered === undefined || entered === "") continue;

    if (field.secret) secretValues[field.name] = entered;
    else publicValues[field.name] = entered;
  }

  return { publicValues, secretValues };
}

// ───────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────

async function validateBridge(bridgeManifest, allValues) {
  const v = bridgeManifest.validate;
  if (!v) return { ok: true };
  if (v.type === "http") return await validateHttp(v, allValues);
  if (v.type === "command") return await validateCommand(v, allValues);
  return { ok: true };
}

function interpolate(template, values) {
  if (typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key === "value") return values.__currentValue || "";
    return values[key] !== undefined ? String(values[key]) : `{${key}}`;
  });
}

async function validateHttp(v, allValues) {
  const url = interpolate(v.url, allValues);
  const headers = { Accept: "application/json" };
  if (v.auth?.type === "basic") {
    const user = interpolate(v.auth.user, allValues);
    const pass = interpolate(v.auth.pass, allValues);
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  } else if (v.auth?.type === "bearer") {
    headers.Authorization = `Bearer ${interpolate(v.auth.token, allValues)}`;
  }

  let resp;
  try {
    resp = await fetch(url, { method: v.method || "GET", headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, error: `Request failed: ${e.message}` };
  }

  if (resp.status === (v.expectStatus || 200)) {
    let body = null;
    try { body = await resp.json(); } catch { /* not JSON; that's fine */ }
    let msg = v.successMessage || "Validated.";
    if (body) {
      msg = msg.replace(/\{response\.([\w.]+)\}/g, (_, path) => {
        const parts = path.split(".");
        let cur = body;
        for (const p of parts) cur = cur?.[p];
        return cur !== undefined ? String(cur) : "";
      });
    }
    // Interpolate any plain {fieldName} placeholders too (e.g., {MIRO_ORG_NAME})
    msg = interpolate(msg, allValues);
    return { ok: true, message: msg };
  }

  const hint = v.errorHints?.[String(resp.status)] || "Validation failed.";
  return { ok: false, status: resp.status, error: `HTTP ${resp.status}: ${hint}` };
}

// Allowlist of commands a bridge manifest can request for validation.
// New entries must be added intentionally — never accept arbitrary commands
// from a downloaded manifest, even if it came from a "trusted" repo.
const VALIDATE_COMMAND_ALLOWLIST = new Set([
  "p4",          // Perforce CLI
  "git",         // git status / config checks
  "node",        // running a bundled health-check script
  "npm",         // running an npm script
  "claude",      // claude mcp list
]);

function isAllowedValidateCommand(name) {
  // Reject anything that looks like a path or contains shell metachars.
  if (typeof name !== "string") return false;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) return false;
  return VALIDATE_COMMAND_ALLOWLIST.has(name);
}

async function validateCommand(v, allValues) {
  const cmd = interpolate(v.command, allValues);
  if (!isAllowedValidateCommand(cmd)) {
    return {
      ok: false,
      error: `Refusing to run validation command '${cmd}': not in allowlist. ` +
             `Allowed: ${[...VALIDATE_COMMAND_ALLOWLIST].join(", ")}. ` +
             `If you trust this bridge and want to allow this command, edit ` +
             `installer/install.mjs and add it to VALIDATE_COMMAND_ALLOWLIST.`,
    };
  }
  const args = (v.args || []).map((a) => interpolate(a, allValues));
  // Security review: cmd is restricted by isAllowedValidateCommand() above
  // (regex-validated short identifier in a fixed allowlist). args is an
  // array passed without shell interpretation. shell:false is explicit.
  // nosemgrep: javascript.lang.security.audit.detect-child-process.detect-child-process,javascript.lang.security.detect-child-process.detect-child-process,javascript.lang.security.audit.dangerous-spawn-shell.dangerous-spawn-shell
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 30000, shell: false });
  if (r.status === (v.expectExitCode ?? 0)) {
    const stdout = (r.stdout || "").trim();
    let msg = v.successMessage || "Command validated.";
    // Supported placeholders:
    //   {<fieldName>}   any field from allValues (P4PORT, etc.)
    //   {stdout}        entire stdout (trimmed)
    //   {stdout.lineN}  Nth non-empty line (1-indexed)
    msg = msg.replace(/\{stdout\.line(\d+)\}/g, (_, n) => {
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
      const idx = parseInt(n, 10) - 1;
      return lines[idx] || "";
    });
    msg = msg.replace(/\{stdout\}/g, stdout);
    msg = interpolate(msg, allValues);
    return { ok: true, message: msg };
  }
  const errOut = (r.stderr || r.stdout || "").trim();
  let hint = "Validation command failed.";
  if (v.errorHints) {
    for (const [pat, h] of Object.entries(v.errorHints)) {
      if (errOut.includes(pat)) { hint = h; break; }
    }
  }
  return { ok: false, error: `${hint}\n${errOut}` };
}

// ───────────────────────────────────────────────────────────────────────
// Bridge with own setup script (e.g., UEMCP)
// ───────────────────────────────────────────────────────────────────────

// Whitelist of file extensions a bridge can declare as its own setup script.
// A bridge cannot ask the installer to run arbitrary executables — only
// scripts of these well-known types resolved relative to the bridge dir.
const SETUP_EXTENSION_ALLOWLIST = new Set([".bat", ".cmd", ".ps1", ".sh", ".mjs", ".js"]);

function runBridgeOwnSetup(bridgeEntry, bridgeDir, workspaceDir) {
  const setup = bridgeEntry.setup;
  if (!setup) return { ok: true };
  if (setup.platform && setup.platform !== process.platform) {
    console.log(`  ${bridgeDir}: setup script is for ${setup.platform}, skipping on ${process.platform}`);
    return { ok: true };
  }

  // Validate the setup.command name: must be a plain filename (no path
  // separators) with an allowed extension. This is anchored to bridgeDir
  // so the installer can't be coerced into running anything outside it.
  const declared = setup.command;
  if (typeof declared !== "string" || declared === "") {
    return { ok: false, status: -1, error: "setup.command missing" };
  }
  if (declared.includes("/") || declared.includes("\\") || declared.includes("..")) {
    return { ok: false, status: -1, error: `setup.command must be a plain filename, got: ${declared}` };
  }
  const dot = declared.lastIndexOf(".");
  const ext = dot >= 0 ? declared.slice(dot).toLowerCase() : "";
  if (!SETUP_EXTENSION_ALLOWLIST.has(ext)) {
    return {
      ok: false,
      status: -1,
      error: `setup.command extension '${ext}' not allowed. Allowed: ${[...SETUP_EXTENSION_ALLOWLIST].join(", ")}`,
    };
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
  const cmdPath = safeJoin(bridgeDir, declared);
  if (!existsSync(cmdPath)) {
    console.log(`  ${declared} not found in bridge dir; skipping its own setup`);
    return { ok: true };
  }

  const args = (setup.args || []).map((a) => a.replace(/\{WORKSPACE\}/g, workspaceDir));
  console.log(`  Running ${declared} ${args.join(" ")}`);

  // Pick a launcher based on extension — never use shell:true. Args are
  // always passed as an array; cmd.exe receives args via /c invocation.
  let launcher, launcherArgs;
  if (ext === ".bat" || ext === ".cmd") {
    launcher = "cmd.exe";
    launcherArgs = ["/c", cmdPath, ...args];
  } else if (ext === ".ps1") {
    launcher = "powershell";
    launcherArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cmdPath, ...args];
  } else if (ext === ".mjs" || ext === ".js") {
    launcher = "node";
    launcherArgs = [cmdPath, ...args];
  } else if (ext === ".sh") {
    launcher = "bash";
    launcherArgs = [cmdPath, ...args];
  }

  // Security review: launcher is one of {cmd.exe, powershell, node, bash}
  // chosen by extension whitelist above; cmdPath is anchored to bridgeDir
  // via safeJoin and the declared filename was validated to contain no
  // path separators. launcherArgs is an array; shell:false is explicit.
  // nosemgrep: javascript.lang.security.audit.detect-child-process.detect-child-process,javascript.lang.security.detect-child-process.detect-child-process,javascript.lang.security.audit.dangerous-spawn-shell.dangerous-spawn-shell
  const r = spawnSync(launcher, launcherArgs, {
    stdio: "inherit",
    cwd: bridgeDir,
    shell: false,
  });
  return { ok: r.status === 0, status: r.status };
}

// ───────────────────────────────────────────────────────────────────────
// Post-setup hook (runs after manifest-driven config is gathered + saved)
//
// Lets a bridge declare a script that runs ONCE per install with values
// gathered from the manifest fields. Used by UEMCP to run sync-plugin.bat
// to copy the UE plugin into the user's project. Subject to the same
// security guards as the setup hook (extension allowlist, plain filename,
// path containment, shell:false).
// ───────────────────────────────────────────────────────────────────────

function runBridgePostSetup(bridgeManifest, bridgeDir, allValues, workspaceDir) {
  const ps = bridgeManifest.postSetup;
  if (!ps) return { ok: true };
  if (ps.platform && ps.platform !== process.platform) {
    printInfo(`Skipping postSetup: script is for ${ps.platform}, you're on ${process.platform}.`);
    return { ok: true };
  }

  const declared = ps.command;
  if (typeof declared !== "string" || declared === "") {
    return { ok: false, error: "postSetup.command missing" };
  }
  if (declared.includes("/") || declared.includes("\\") || declared.includes("..")) {
    return { ok: false, error: `postSetup.command must be a plain filename, got: ${declared}` };
  }
  const dot = declared.lastIndexOf(".");
  const ext = dot >= 0 ? declared.slice(dot).toLowerCase() : "";
  if (!SETUP_EXTENSION_ALLOWLIST.has(ext)) {
    return { ok: false, error: `postSetup.command extension '${ext}' not allowed. Allowed: ${[...SETUP_EXTENSION_ALLOWLIST].join(", ")}` };
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
  const cmdPath = safeJoin(bridgeDir, declared);
  if (!existsSync(cmdPath)) {
    printWarn(`postSetup.command not found in bridge dir: ${declared}`);
    return { ok: true };
  }

  // Interpolate {fieldName} and {WORKSPACE} placeholders in args
  const interpValues = { ...allValues, WORKSPACE: workspaceDir };
  const args = (ps.args || []).map((a) => interpolate(a, interpValues));

  if (ps.description) printInfo(ps.description);
  printInfo(`Running ${declared} ${args.join(" ")}`);

  let launcher, launcherArgs;
  if (ext === ".bat" || ext === ".cmd") {
    launcher = "cmd.exe";
    launcherArgs = ["/c", cmdPath, ...args];
  } else if (ext === ".ps1") {
    launcher = "powershell";
    launcherArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cmdPath, ...args];
  } else if (ext === ".mjs" || ext === ".js") {
    launcher = "node";
    launcherArgs = [cmdPath, ...args];
  } else if (ext === ".sh") {
    launcher = "bash";
    launcherArgs = [cmdPath, ...args];
  }

  // Security review: same as runBridgeOwnSetup — launcher is from a fixed
  // whitelist, cmdPath is safeJoin-anchored to bridgeDir, args are array,
  // shell:false explicit.
  // nosemgrep: javascript.lang.security.audit.detect-child-process.detect-child-process,javascript.lang.security.detect-child-process.detect-child-process,javascript.lang.security.audit.dangerous-spawn-shell.dangerous-spawn-shell
  const r = spawnSync(launcher, launcherArgs, {
    stdio: "inherit",
    cwd: bridgeDir,
    shell: false,
  });
  return { ok: r.status === 0, status: r.status };
}

// ───────────────────────────────────────────────────────────────────────
// Doctor mode
// ───────────────────────────────────────────────────────────────────────

function runDoctor(workspaceDir, rootManifest) {
  console.log(`\nDoctor report - workspace: ${workspaceDir}\n`);
  const cfg = loadWorkspaceConfig(workspaceDir);
  if (!cfg.publicExisted) {
    console.log(`  No ${PUBLIC_FILE} found. Run installer to set one up.`);
    return 1;
  }
  console.log(`  ${PUBLIC_FILE}: present${cfg.secretsExisted ? ` (+ ${SECRET_FILE})` : ""}`);
  console.log(`  Layout: ${cfg.public.bridges ? "modern" : "legacy"}\n`);

  let issues = 0;
  for (const [name, entry] of Object.entries(rootManifest.bridges)) {
    const declared = cfg.public.bridges?.[name];
    const legacy = cfg.public.mcpServers?.[name];
    const enabled = declared?.enabled !== false && (declared || legacy);
    const status = !declared && !legacy ? "absent" : enabled ? "enabled" : "disabled";
    console.log(`  ${name.padEnd(12)} ${status.padEnd(10)} ${entry.displayName || ""}`);
  }
  console.log("");
  return issues > 0 ? 1 : 0;
}

// ───────────────────────────────────────────────────────────────────────
// Install flow
// ───────────────────────────────────────────────────────────────────────

async function runInstall(args, rootManifest) {
  const workspaceDir = safePath(args.workspace || process.cwd(), { label: "workspace" });
  if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) {
    console.error(`Workspace path is not a directory: ${workspaceDir}`);
    return 2;
  }

  // (Header is shown by install.ps1 when launched from the GUI;
  //  here we just print the workspace context for clarity in either case.)
  if (!process.env.MCP_INSTALLER_HEADER_SHOWN) {
    printSection("AI-Tools MCP Bridge Installer");
  }
  console.log(`  Workspace: ${workspaceDir}\n`);

  // Update check (best-effort, throttled)
  await maybeCheckForUpdates(rootManifest, args.update);

  // Pick bridges
  const allBridges = Object.entries(rootManifest.bridges);
  const cfg = loadWorkspaceConfig(workspaceDir);
  const previouslyEnabled = new Set();
  for (const [name] of allBridges) {
    if (cfg.public.bridges?.[name]?.enabled === true) previouslyEnabled.add(name);
    else if (cfg.public.mcpServers?.[name]) previouslyEnabled.add(name);
  }

  let chosen;
  if (args.bridges) {
    chosen = args.bridges.filter((n) => rootManifest.bridges[n]);
    const bad = args.bridges.filter((n) => !rootManifest.bridges[n]);
    if (bad.length > 0) console.log(`Skipping unknown: ${bad.join(", ")}`);
  } else {
    const items = allBridges.map(([name, entry]) => ({
      name,
      description: entry.summary || entry.displayName || name,
      checked: previouslyEnabled.has(name),
    }));
    chosen = await multiSelect("Select bridges to ENABLE for this workspace:", items);
  }

  if (chosen.length === 0) {
    console.log(`\nNo bridges selected. Existing config (if any) left as-is.\n`);
    return 0;
  }

  // Disable bridges that were previously enabled but not selected this run
  for (const [name] of allBridges) {
    if (previouslyEnabled.has(name) && !chosen.includes(name)) {
      const disable = await confirm(
        `'${name}' was enabled before but is not selected now. Mark disabled? (config is preserved)`,
        true,
      );
      if (disable) disableBridgeInConfig(cfg, name);
    }
  }

  const backupTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  for (const name of chosen) {
    const entry = rootManifest.bridges[name];
    printSection(`Configure: ${entry.displayName || name}`);

    // Make bridge files available (download if remote)
    let bridgeDir;
    try {
      bridgeDir = await ensureBridgeAvailable(entry, name);
    } catch (e) {
      printErr(`Could not fetch bridge: ${e.message}`);
      continue;
    }

    // If bridge has its own setup script, prefer that
    if (entry.setup?.command) {
      printInfo(`This bridge has its own setup script: ${entry.setup.command}`);
      const useOwn = await confirm(`  Run ${entry.setup.command}?`, true);
      if (useOwn) {
        const result = runBridgeOwnSetup(entry, bridgeDir, workspaceDir);
        if (!result.ok) {
          printErr(`Setup script exited with status ${result.status}`);
          continue;
        }
        // The bridge's own setup wrote .mcp.json; we just record that it's enabled
        cfg.public.bridges = cfg.public.bridges || {};
        cfg.public.bridges[name] = { ...(cfg.public.bridges[name] || {}), enabled: true, version: "external" };
        continue;
      }
    }

    // Default flow: read manifest, gather creds, validate, write config
    let bridgeManifest;
    try {
      bridgeManifest = loadBridgeManifest(bridgeDir);
    } catch (e) {
      // Remote-repo bridges may not have a manifest.json yet (e.g. UEMCP
      // before its manifest is added). If the workspace already has a
      // legacy mcpServers entry for this bridge, preserve it and report.
      if (entry.fallback?.preserveLegacyConfig) {
        const existingLegacy = cfg.public.mcpServers?.[name];
        if (existingLegacy) {
          printWarn(`No manifest.json found in bridge bundle.`);
          printInfo(`Preserving existing workspace config for '${name}'.`);
          if (entry.fallback.manifestNeeded) {
            printInfo(`To enable installer-driven setup, add manifest.json to the bridge repo (see ${entry.fallback.manifestNeeded}).`);
          }
          cfg.public.bridges = cfg.public.bridges || {};
          cfg.public.bridges[name] = {
            ...(cfg.public.bridges[name] || {}),
            enabled: true,
            version: "legacy-passthrough",
          };
          continue;
        }
        printErr(`No manifest.json found in '${name}' bundle and no existing config to preserve.`);
        if (entry.fallback.manifestNeeded) {
          printInfo(`Add manifest.json to the bridge repo to enable installer-driven setup (see ${entry.fallback.manifestNeeded}).`);
        }
        continue;
      }
      printErr(e.message);
      continue;
    }

    const detected = autoDetect(bridgeManifest, workspaceDir);
    if (Object.keys(detected).length > 0) {
      printInfo(`Auto-detected from workspace: ${Object.keys(detected).join(", ")}`);
    }

    // Read existing values from BOTH layouts:
    //  - Modern: cfg.public.bridges.<name> (preferred)
    //  - Legacy: cfg.public.mcpServers.<name>.env (for first-run migration)
    // Modern wins if both present. Same for secrets.
    const existingPublic = {
      ...(cfg.public.mcpServers?.[name]?.env || {}),
      ...(cfg.public.bridges?.[name] || {}),
    };
    delete existingPublic.PROJECT_ROOT; // never carry over
    delete existingPublic.enabled;
    delete existingPublic.version;
    const existingSecrets = {
      ...(cfg.secrets.mcpServers?.[name]?.env || {}),
      ...(cfg.secrets.bridges?.[name] || {}),
    };

    // Gather + validate, with retry loop so user can correct creds
    // without re-running the installer.
    let creds;
    let allValues;
    let validationOk = false;
    let abandoned = false;
    let inheritedPublic = existingPublic;
    let inheritedSecrets = existingSecrets;
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        creds = await gatherCredentials(bridgeManifest, detected, inheritedPublic, inheritedSecrets);
      } catch (e) {
        printErr(`Aborted: ${e.message}`);
        abandoned = true;
        break;
      }

      allValues = { ...creds.publicValues, ...creds.secretValues };
      process.stdout.write("\n  \x1b[2mValidating credentials...\x1b[0m");
      const result = await validateBridge(bridgeManifest, allValues);
      process.stdout.write("\r\x1b[2K");

      if (result.ok) {
        printOk(result.message || "Credentials validated successfully.");
        validationOk = true;
        break;
      }

      printErr(`Validation failed: ${result.error || "(no details)"}`);

      if (attempt < MAX_ATTEMPTS) {
        const retry = await confirm(`  Re-enter credentials and try again?`, true);
        if (retry) {
          // Carry the just-entered values forward as the new "current" so
          // the user only re-types the bits that need changing.
          inheritedPublic = { ...inheritedPublic, ...creds.publicValues };
          inheritedSecrets = { ...inheritedSecrets, ...creds.secretValues };
          continue;
        }
      } else {
        printWarn(`Reached ${MAX_ATTEMPTS}-attempt limit.`);
      }

      // User declined retry (or hit attempt limit) — offer to save anyway
      const proceed = await confirm(`  Save these credentials anyway? (Bridge will fail at runtime)`, false);
      if (!proceed) {
        printWarn(`Skipped saving '${name}'. Re-run installer to retry.`);
        abandoned = true;
      }
      break;
    }

    if (abandoned) continue;

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
    const serverPath = safeJoin(bridgeDir, bridgeManifest.main || "server.mjs");
    setBridgeInConfig(cfg, name, creds.publicValues, creds.secretValues, serverPath, {
      enabled: true,
      version: bridgeManifest.version || "1.0.0",
    });

    // Run optional post-setup hook (e.g., UEMCP's sync-plugin.bat to copy
    // the UE plugin into the user's project). Failures here are warnings,
    // not blockers — the bridge config has already been saved.
    if (bridgeManifest.postSetup) {
      const psResult = runBridgePostSetup(bridgeManifest, bridgeDir, allValues, workspaceDir);
      if (psResult.ok) {
        printOk(`Post-setup completed.`);
      } else {
        printWarn(`Post-setup failed: ${psResult.error || `exit ${psResult.status}`}`);
        printInfo(`The bridge config was saved; you may need to deploy any required assets manually.`);
      }
    }
  }

  writeWorkspaceConfig(cfg, { backupTag });

  const ignoredFiles = ensureSecretIgnored(workspaceDir);
  for (const f of ignoredFiles) {
    console.log(`  Added '${SECRET_FILE}' to ${f}`);
  }

  console.log(`\nDone. Run 'install.bat --doctor' to verify.\n`);

  // Optional update-check hook
  if (args.enableUpdateChecks) {
    enableSessionStartHook(workspaceDir, rootManifest);
  }

  return 0;
}

function enableSessionStartHook(workspaceDir, rootManifest) {
  const hooksDir = safeJoin(workspaceDir, ".claude");
  if (!existsSync(hooksDir)) {
    console.log(`  No .claude/ dir found in workspace; skipping SessionStart hook setup.`);
    return;
  }
  const settingsPath = safeJoin(hooksDir, "settings.local.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* ignore */ }
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];
  // Idempotent: don't add if already present
  const alreadyPresent = JSON.stringify(settings.hooks.SessionStart).includes("mcp-bridges-update");
  if (alreadyPresent) {
    console.log(`  Update-check hook already present in settings.local.json.`);
    return;
  }
  // The actual hook command is intentionally simple — calls install.mjs --doctor
  // and only prints if a newer version is reported.
  const repo = parseRepoFromHomepage(rootManifest.homepage) || "noahbutcher97/AI-Tools";
  settings.hooks.SessionStart.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${__dirname.replace(/\\/g, "/")}/install.mjs" --doctor 2>/dev/null | grep -E '>> Update available' || true # mcp-bridges-update-check`,
      },
    ],
  });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`  Added SessionStart update-check hook to ${settingsPath}`);
}

// ───────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs(process.argv);
  const rootManifest = loadRootManifest();

  if (args.mode === "doctor") {
    const workspace = safePath(args.workspace || process.cwd(), { label: "workspace" });
    const code = runDoctor(workspace, rootManifest);
    process.exit(code);
  }

  const code = await runInstall(args, rootManifest);
  process.exit(code);
})().catch((e) => {
  if (e && typeof e.message === "string" && e.message.includes("Cancelled by user")) {
    console.log("\nCancelled.");
    process.exit(130);
  }
  console.error(`Installer error: ${e.stack || e.message}`);
  process.exit(99);
});
