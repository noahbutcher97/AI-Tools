// _shared/resolve-config.mjs
// Runtime config resolution shared by all bridge servers.
//
// Tier 1: Direct env vars (escape hatch — bridge-specific keys passed in env)
// Tier 2: PROJECT_ROOT env var -> read .mcp.json (and .mcp.local.json overlay) at that path
// Tier 3: CWD walk-up -> find nearest .mcp.json (and overlay)
//
// Secrets in .mcp.local.json are merged over public values from .mcp.json.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { safeJoin, safePath } from "./safepath.mjs";

export const CONFIG_FILENAME = ".mcp.json";
export const SECRET_FILENAME = ".mcp.local.json";

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(`[resolve-config] parse error at ${filePath}: ${e.message}`);
    return null;
  }
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  if (!target || typeof target !== "object") return source;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

export function loadConfigAt(dirPath) {
  // dirPath is validated by safePath() before any path joins below.
  const safe = safePath(dirPath, { label: "config dir" });
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
  const publicPath = safeJoin(safe, CONFIG_FILENAME);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
  const secretPath = safeJoin(safe, SECRET_FILENAME);
  const publicCfg = readJsonSafe(publicPath);
  if (!publicCfg) return null;
  const secretCfg = readJsonSafe(secretPath);
  const merged = secretCfg ? deepMerge(publicCfg, secretCfg) : publicCfg;
  merged.__sourceDir = safe;
  merged.__hasSecrets = !!secretCfg;
  return merged;
}

export function findConfigUpward(startDir) {
  // startDir is validated by safePath(); dirname only operates on already-validated paths.
  let dir = safePath(startDir, { label: "start dir" });
  const root = resolve("/");
  while (dir !== root) {
    const cfg = loadConfigAt(dir);
    if (cfg) return { config: cfg, dir };
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-traversal
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Pull bridge-specific values from a config. Supports both modern
 * (config.bridges.<name>) and legacy (config.mcpServers.<name>.env) layouts.
 * Honors enabled flag — returns null if explicitly disabled.
 */
function extractBridgeValues(config, bridgeName, fields) {
  const modern = config?.bridges?.[bridgeName];
  if (modern && typeof modern === "object") {
    if (modern.enabled === false) return null;
    const out = {};
    let any = false;
    for (const f of fields) {
      if (modern[f] !== undefined && modern[f] !== "") {
        out[f] = modern[f];
        any = true;
      }
    }
    if (any) return out;
  }
  const legacy = config?.mcpServers?.[bridgeName]?.env;
  if (legacy && typeof legacy === "object") {
    const out = {};
    let any = false;
    for (const f of fields) {
      if (legacy[f] !== undefined && legacy[f] !== "") {
        out[f] = legacy[f];
        any = true;
      }
    }
    if (any) return out;
  }
  return null;
}

/**
 * Three-tier resolution. Returns {values, source} or null.
 */
export function resolveBridgeConfig(bridgeName, fields, opts = {}) {
  const { logger = console.error } = opts;
  const tag = `[${bridgeName}-bridge]`;

  // Tier 1: env
  const envValues = {};
  let envHasAll = true;
  for (const f of fields) {
    if (process.env[f] !== undefined && process.env[f] !== "") {
      envValues[f] = process.env[f];
    } else {
      envHasAll = false;
    }
  }
  if (envHasAll) {
    logger(`${tag} Using direct env credentials`);
    return { values: envValues, source: "env" };
  }

  // Tier 2: PROJECT_ROOT
  if (process.env.PROJECT_ROOT) {
    let dir;
    try { dir = safePath(process.env.PROJECT_ROOT, { label: "PROJECT_ROOT" }); }
    catch (e) { logger(`${tag} PROJECT_ROOT invalid: ${e.message}`); }
    if (dir) {
      const cfg = loadConfigAt(dir);
      if (cfg) {
        const vals = extractBridgeValues(cfg, bridgeName, fields);
        if (vals) {
          logger(`${tag} Loaded from PROJECT_ROOT: ${dir}${cfg.__hasSecrets ? " (+ .mcp.local.json)" : ""}`);
          return { values: vals, source: dir };
        }
        logger(`${tag} PROJECT_ROOT=${dir} has .mcp.json but no usable '${bridgeName}' entry`);
      } else {
        logger(`${tag} PROJECT_ROOT=${dir} has no .mcp.json`);
      }
    }
  }

  // Tier 3: CWD walk-up
  const found = findConfigUpward(process.cwd());
  if (found) {
    const vals = extractBridgeValues(found.config, bridgeName, fields);
    if (vals) {
      logger(`${tag} Loaded via cwd walk-up: ${found.dir}${found.config.__hasSecrets ? " (+ .mcp.local.json)" : ""}`);
      return { values: vals, source: found.dir };
    }
    logger(`${tag} Found .mcp.json at ${found.dir} but no usable '${bridgeName}' entry`);
  }

  return null;
}

export function isBridgeEnabled(config, bridgeName) {
  if (config?.bridges?.[bridgeName]?.enabled === true) return true;
  if (config?.bridges?.[bridgeName]?.enabled === false) return false;
  return !!config?.mcpServers?.[bridgeName];
}
