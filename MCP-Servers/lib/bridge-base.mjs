// _shared/bridge-base.mjs
// Helper that bridge servers call at startup to load their config via the
// shared 3-tier resolver. Bridges receive a flat values object back and
// proceed with their normal MCP server setup.

import { resolveBridgeConfig } from "./resolve-config.mjs";

/**
 * Load and validate config for a bridge. Required-field check + default
 * application. On any missing required field, prints a helpful message
 * and exits the process.
 *
 * @param {string} bridgeName
 * @param {Array<{name, required, secret?, default?}>} fieldDescriptors - from manifest.json
 * @returns {{values: object, source: string}} resolved config
 */
export function loadBridgeConfigOrExit(bridgeName, fieldDescriptors) {
  const fieldNames = fieldDescriptors.map((f) => f.name);
  const resolved = resolveBridgeConfig(bridgeName, fieldNames);

  if (!resolved) {
    console.error(`[${bridgeName}-bridge] No config found via env, PROJECT_ROOT, or cwd walk-up.`);
    console.error(`[${bridgeName}-bridge] Run the installer: install.bat`);
    process.exit(1);
  }

  const values = { ...resolved.values };
  for (const f of fieldDescriptors) {
    if ((values[f.name] === undefined || values[f.name] === "") && f.default !== undefined) {
      values[f.name] = f.default;
    }
  }

  const missing = [];
  for (const f of fieldDescriptors) {
    if (f.required && (values[f.name] === undefined || values[f.name] === "")) {
      missing.push(f.name);
    }
  }
  if (missing.length > 0) {
    console.error(`[${bridgeName}-bridge] Missing required fields: ${missing.join(", ")}`);
    console.error(`[${bridgeName}-bridge] Source: ${resolved.source}`);
    console.error(`[${bridgeName}-bridge] Run the installer to fix: install.bat`);
    process.exit(1);
  }

  // Inject into process.env so bridge code that reads process.env keeps working
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null) {
      process.env[k] = String(v);
    }
  }

  return { values, source: resolved.source };
}
