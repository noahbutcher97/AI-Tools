// mcp-config.mjs
// Read / write / merge .mcp.json + .mcp.local.json for a workspace.
// Public + secret split: secrets always go to .mcp.local.json which gets
// added to .gitignore / .p4ignore.local.

import { readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync } from "fs";
import { safeJoin } from "./safepath.mjs";

export const PUBLIC_FILE = ".mcp.json";
export const SECRET_FILE = ".mcp.local.json";

/** Read JSON safely; return null on missing/parse error. */
export function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`Could not parse ${path}: ${e.message}`);
    return null;
  }
}

/** Load both public + secret config for a workspace. */
export function loadWorkspaceConfig(workspaceDir) {
  const publicPath = safeJoin(workspaceDir, PUBLIC_FILE);
  const secretPath = safeJoin(workspaceDir, SECRET_FILE);
  return {
    publicPath,
    secretPath,
    public: readJsonSafe(publicPath) || {},
    secrets: readJsonSafe(secretPath) || {},
    publicExisted: existsSync(publicPath),
    secretsExisted: existsSync(secretPath),
  };
}

/**
 * Add or update a bridge entry in the workspace config.
 *
 * publicValues  = non-secret fields (P4PORT, ATLASSIAN_SITE_NAME, etc.)
 * secretValues  = secret fields (P4PASSWD, ATLASSIAN_API_TOKEN, etc.)
 * serverPath    = absolute path to the bridge's server.mjs
 * meta          = { enabled: bool, version: string }
 *
 * Layout written:
 *   .mcp.json:
 *     mcpServers.<name>.command/args/env (env contains public values + PROJECT_ROOT)
 *     bridges.<name>.{enabled, version, ...publicValues}
 *   .mcp.local.json:
 *     bridges.<name>.{...secretValues}
 *
 * Existing config for OTHER bridges is preserved.
 */
export function setBridgeInConfig(cfg, bridgeName, publicValues, secretValues, serverPath, meta = {}) {
  const { enabled = true, version = "0.0.0" } = meta;

  cfg.public.mcpServers = cfg.public.mcpServers || {};
  cfg.public.bridges    = cfg.public.bridges    || {};
  cfg.secrets.bridges   = cfg.secrets.bridges   || {};

  if (enabled) {
    cfg.public.mcpServers[bridgeName] = {
      command: "node",
      args: [serverPath.replace(/\\/g, "/")],
      env: {
        ...publicValues,
        // PROJECT_ROOT lets the bridge fall back to .mcp.json lookup if env vars somehow missing
        PROJECT_ROOT: cfg.publicPath.replace(/\\[^\\]+$/, "").replace(/\\/g, "/"),
      },
    };
  } else {
    delete cfg.public.mcpServers[bridgeName];
  }

  cfg.public.bridges[bridgeName] = {
    enabled,
    version,
    ...publicValues,
  };

  if (Object.keys(secretValues || {}).length > 0) {
    cfg.secrets.bridges[bridgeName] = { ...secretValues };
  }
  return cfg;
}

/**
 * Mark a bridge as disabled without losing its config.
 */
export function disableBridgeInConfig(cfg, bridgeName) {
  delete cfg.public.mcpServers?.[bridgeName];
  if (cfg.public.bridges?.[bridgeName]) {
    cfg.public.bridges[bridgeName].enabled = false;
  }
  return cfg;
}

/**
 * Persist both files. Backs up any existing files with a timestamped suffix
 * the first time they're touched in a session (caller passes backupTag once).
 */
export function writeWorkspaceConfig(cfg, opts = {}) {
  const { backupTag = null } = opts;

  if (backupTag) {
    if (cfg.publicExisted) {
      try { copyFileSync(cfg.publicPath, `${cfg.publicPath}.bak.${backupTag}`); }
      catch { /* ignore */ }
    }
    if (cfg.secretsExisted) {
      try { copyFileSync(cfg.secretPath, `${cfg.secretPath}.bak.${backupTag}`); }
      catch { /* ignore */ }
    }
  }

  const publicOut = stripInternal(cfg.public);
  writeFileSync(cfg.publicPath, JSON.stringify(publicOut, null, 2) + "\n", "utf-8");

  if (Object.keys(cfg.secrets.bridges || {}).length > 0) {
    const secretOut = stripInternal(cfg.secrets);
    writeFileSync(cfg.secretPath, JSON.stringify(secretOut, null, 2) + "\n", "utf-8");
  }
}

/**
 * Ensure SECRET_FILE is in .gitignore and .p4ignore.local where applicable.
 */
export function ensureSecretIgnored(workspaceDir) {
  const candidates = [
    { path: safeJoin(workspaceDir, ".gitignore"),       relevantWhen: existsSync(safeJoin(workspaceDir, ".git")) || existsSync(safeJoin(workspaceDir, ".gitignore")) },
    { path: safeJoin(workspaceDir, ".p4ignore.local"), relevantWhen: existsSync(safeJoin(workspaceDir, ".p4config")) || existsSync(safeJoin(workspaceDir, ".p4ignore.local")) || existsSync(safeJoin(workspaceDir, ".p4ignore")) },
  ];
  const updates = [];
  for (const { path, relevantWhen } of candidates) {
    if (!relevantWhen) continue;
    let content = "";
    if (existsSync(path)) content = readFileSync(path, "utf-8");
    if (content.split(/\r?\n/).some((l) => l.trim() === SECRET_FILE)) continue;
    const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${sep}${SECRET_FILE}\n`);
    updates.push(path);
  }
  return updates;
}

function stripInternal(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("__")) continue;
    out[k] = (v && typeof v === "object" && !Array.isArray(v)) ? stripInternal(v) : v;
  }
  return out;
}
