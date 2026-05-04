// cache.mjs
// Manages the local cache of downloaded bridge releases.
// Cache lives at %LOCALAPPDATA%/mcp-bridges/cache (Windows) or ~/.cache/mcp-bridges (POSIX).

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "fs";
import os from "os";
import { safeJoin, safePath } from "./safepath.mjs";

const CACHE_NAME = "mcp-bridges";

export function cacheRoot() {
  let base;
  if (process.platform === "win32") {
    base = process.env.LOCALAPPDATA || safeJoin(os.homedir(), "AppData", "Local");
  } else {
    base = process.env.XDG_CACHE_HOME || safeJoin(os.homedir(), ".cache");
  }
  const root = safeJoin(base, CACHE_NAME);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Get the cache directory for a given bridge release.
 * @param {string} bridgeName
 * @param {string} version
 */
export function bridgeVersionDir(bridgeName, version) {
  if (typeof bridgeName !== "string" || !/^[a-z0-9_-]+$/i.test(bridgeName)) {
    throw new Error(`Invalid bridge name: ${bridgeName}`);
  }
  if (typeof version !== "string" || !/^[a-zA-Z0-9._+-]+$/.test(version)) {
    throw new Error(`Invalid version string: ${version}`);
  }
  const dir = safeJoin(cacheRoot(), "bridges", bridgeName, version);
  return dir;
}

/**
 * Returns the file used to store the timestamp of the last update check.
 * Per-resource (one per repo).
 */
export function lastCheckFile(repoSlug) {
  if (typeof repoSlug !== "string" || !/^[a-zA-Z0-9._/-]+$/.test(repoSlug)) {
    throw new Error(`Invalid repo slug: ${repoSlug}`);
  }
  const safe = repoSlug.replace(/[/\\]/g, "__");
  const dir = safeJoin(cacheRoot(), "checks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return safeJoin(dir, `${safe}.json`);
}

/**
 * Read the last update-check timestamp + tag for a repo. Returns null if absent.
 */
export function readLastCheck(repoSlug) {
  const path = lastCheckFile(repoSlug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Persist the most recent update-check result.
 */
export function writeLastCheck(repoSlug, info) {
  const path = lastCheckFile(repoSlug);
  writeFileSync(path, JSON.stringify({
    checkedAt: new Date().toISOString(),
    ...info,
  }, null, 2), "utf-8");
}

/**
 * Has the user been throttled below the daily check limit?
 */
export function isCheckRateLimited(repoSlug, ttlMs = 24 * 60 * 60 * 1000) {
  const last = readLastCheck(repoSlug);
  if (!last || !last.checkedAt) return false;
  const elapsed = Date.now() - new Date(last.checkedAt).getTime();
  return elapsed < ttlMs;
}

/**
 * List installed cached versions for a bridge.
 */
export function listInstalledVersions(bridgeName) {
  const dir = safeJoin(cacheRoot(), "bridges", bridgeName);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((d) => {
      const full = safeJoin(dir, d);
      try { return existsSync(safeJoin(full, "manifest.json")) || existsSync(safeJoin(full, "package.json")); }
      catch { return false; }
    });
  } catch {
    return [];
  }
}

/**
 * Delete a specific cached version (used during cleanup or forced refresh).
 */
export function clearVersion(bridgeName, version) {
  const dir = bridgeVersionDir(bridgeName, version);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
