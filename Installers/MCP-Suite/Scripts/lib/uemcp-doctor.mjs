import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIRED_PROJECT_PLUGINS = Object.freeze([
  "RemoteControl",
  "PythonScriptPlugin",
  "GeometryScripting",
]);
const BUILD_STALE_TOLERANCE_MS = 2000;
const BUILD_INPUT_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".inl", ".cs"]);

export function evaluateUemcpHealth({ cfg, bridge }) {
  const issues = [];
  const facts = {};
  const launchEnv = cfg?.public?.mcpServers?.uemcp?.env || {};
  const bridgeRecord = cfg?.public?.bridges?.uemcp || {};

  const projectRootValue = firstString(launchEnv.UNREAL_PROJECT_ROOT, bridgeRecord.UNREAL_PROJECT_ROOT);
  const projectName = firstString(launchEnv.UNREAL_PROJECT_NAME, bridgeRecord.UNREAL_PROJECT_NAME);
  const configuredTimeout = firstString(launchEnv.UNREAL_TCP_TIMEOUT_MS, bridgeRecord.UNREAL_TCP_TIMEOUT_MS);

  facts.serverPath = bridge?.facts?.serverPath || null;
  facts.manifestPath = bridge?.facts?.manifestPath || null;
  facts.configuredTimeout = configuredTimeout || null;

  if (!projectRootValue || !projectName) {
    issue(issues, "uemcp-project-config-missing", "error", "UEMCP project config is missing.", "Set public UNREAL_PROJECT_ROOT and UNREAL_PROJECT_NAME for the UEMCP bridge.");
    return { facts, issues };
  }

  const projectRoot = resolve(projectRootValue);
  const projectPath = join(projectRoot, `${projectName}.uproject`);
  const pluginRoot = join(projectRoot, "Plugins", "UEMCP");
  const pluginDescriptorPath = join(pluginRoot, "UEMCP.uplugin");
  const markerPath = join(pluginRoot, ".uemcp-deploy-marker.json");
  const dllPath = join(pluginRoot, "Binaries", "Win64", "UnrealEditor-UEMCP.dll");

  Object.assign(facts, {
    projectRoot,
    projectName,
    projectPath,
    pluginDescriptorPath,
    deployMarkerPath: markerPath,
    editorDllPath: dllPath,
  });

  const project = readJsonIfExists(projectPath);
  if (!project.exists) {
    issue(issues, "uemcp-project-missing", "error", "UEMCP target .uproject file is missing.", "Check UNREAL_PROJECT_ROOT and UNREAL_PROJECT_NAME.");
  } else if (!project.ok) {
    issue(issues, "uemcp-project-json-invalid", "error", `UEMCP target .uproject JSON could not be parsed: ${project.error}`, "Fix the .uproject JSON and re-run doctor.");
  } else {
    const enabled = new Set((project.data.Plugins || [])
      .filter((plugin) => plugin?.Enabled === true)
      .map((plugin) => plugin.Name));
    const missing = REQUIRED_PROJECT_PLUGINS.filter((name) => !enabled.has(name));
    if (missing.length > 0) {
      issue(issues, "uemcp-needs-project-deps", "warning", `Target .uproject is missing required plugins: ${missing.join(", ")}.`, "Run UEMCP setup or enable required plugins, then rebuild/restart Unreal.");
    }
  }

  const plugin = readJsonIfExists(pluginDescriptorPath);
  if (!plugin.exists) {
    issue(issues, "uemcp-plugin-missing", "error", "UEMCP plugin descriptor is missing from the target project.", "Run UEMCP sync/setup for this project.");
  } else if (!plugin.ok) {
    issue(issues, "uemcp-plugin-json-invalid", "error", `UEMCP plugin descriptor JSON could not be parsed: ${plugin.error}`, "Fix or re-sync the UEMCP plugin descriptor.");
  } else {
    facts.pluginVersion = versionString(plugin.data.VersionName || plugin.data.Version);
  }

  const marker = readJsonIfExists(markerPath);
  if (!marker.exists) {
    issue(issues, "uemcp-needs-sync", "warning", "UEMCP deploy marker is missing.", "Run UEMCP sync/setup for this project.");
  } else if (!marker.ok) {
    issue(issues, "uemcp-marker-json-invalid", "warning", `UEMCP deploy marker JSON could not be parsed: ${marker.error}`, "Re-run UEMCP sync/setup to refresh the deploy marker.");
  } else {
    facts.deployMarkerVersion = versionString(marker.data.manifestVersion || marker.data.upluginVersionName);
  }

  const configuredServerVersion = firstString(bridge?.facts?.manifestVersion, bridgeRecord.version);
  facts.configuredServerVersion = configuredServerVersion || null;
  facts.deployedVersion = firstString(facts.deployMarkerVersion, facts.pluginVersion);
  if (configuredServerVersion && facts.deployMarkerVersion && configuredServerVersion !== facts.deployMarkerVersion) {
    issue(issues, "uemcp-version-mismatch", "warning", `Configured server bundle is ${configuredServerVersion}, but deploy marker is ${facts.deployMarkerVersion}.`, "Sync UEMCP so the configured server bundle and deployed project plugin match.");
  }
  if (configuredServerVersion && facts.pluginVersion && configuredServerVersion !== facts.pluginVersion) {
    issue(issues, "uemcp-version-mismatch", "warning", `Configured server bundle is ${configuredServerVersion}, but deployed UEMCP plugin descriptor is ${facts.pluginVersion}.`, "Sync UEMCP so the configured server bundle and deployed project plugin match.");
  }
  if (facts.deployMarkerVersion && facts.pluginVersion && facts.deployMarkerVersion !== facts.pluginVersion) {
    issue(issues, "uemcp-version-mismatch", "warning", `UEMCP deploy marker is ${facts.deployMarkerVersion}, but deployed plugin descriptor is ${facts.pluginVersion}.`, "Re-run UEMCP sync/setup so deploy marker and plugin descriptor match.");
  }

  const defaultTimeout = facts.manifestPath ? readManifestDefault(facts.manifestPath, "UNREAL_TCP_TIMEOUT_MS") : null;
  facts.defaultTimeout = defaultTimeout || null;
  if (configuredTimeout && defaultTimeout && configuredTimeout !== defaultTimeout) {
    issue(issues, "uemcp-timeout-drift", "warning", `UNREAL_TCP_TIMEOUT_MS is ${configuredTimeout}, bundle default is ${defaultTimeout}.`, "Update workspace config if this is not an intentional override.");
  }

  if (!existsSync(dllPath)) {
    issue(issues, "uemcp-needs-build", "warning", "UEMCP editor DLL is missing.", "Build the Unreal project after syncing the plugin.");
  } else {
    const staleBuildInputs = findStaleBuildInputs({ pluginRoot, dllPath });
    facts.staleBuildInputs = staleBuildInputs;
    if (staleBuildInputs.length > 0) {
      issue(issues, "uemcp-build-stale", "warning", `UEMCP editor DLL may be stale; ${staleBuildInputs.length} plugin build input(s) are newer than the DLL.`, "Rebuild the Unreal project so the editor DLL matches the deployed UEMCP sources.");
    }
  }

  return { facts, issues };
}

function findStaleBuildInputs({ pluginRoot, dllPath }) {
  let dllStat;
  try {
    dllStat = statSync(dllPath);
  } catch {
    return [];
  }

  const inputs = listBuildInputs(join(pluginRoot, "Source"));

  return inputs.filter((inputPath) => {
    try {
      return statSync(inputPath).mtimeMs > dllStat.mtimeMs + BUILD_STALE_TOLERANCE_MS;
    } catch {
      return false;
    }
  });
}

function listBuildInputs(root) {
  if (!existsSync(root)) return [];
  const inputs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      inputs.push(...listBuildInputs(path));
      continue;
    }
    if (entry.isFile() && isBuildInput(path)) {
      inputs.push(path);
    }
  }
  return inputs;
}

function isBuildInput(path) {
  const lower = path.toLowerCase();
  for (const extension of BUILD_INPUT_EXTENSIONS) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return { exists: false, ok: true, data: null, error: null };
  try {
    return { exists: true, ok: true, data: JSON.parse(readFileSync(path, "utf-8")), error: null };
  } catch (error) {
    return { exists: true, ok: false, data: null, error: error.message };
  }
}

function readManifestDefault(manifestPath, fieldName) {
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest.ok || !manifest.data) return null;
  const field = (manifest.data.fields || []).find((entry) => entry?.name === fieldName);
  return versionString(field?.default ?? field?.defaultValue);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

function versionString(value) {
  if (value === null || value === undefined) return null;
  const stringValue = String(value).trim();
  return stringValue === "" ? null : stringValue;
}

function issue(issues, code, severity, message, action) {
  issues.push({ code, severity, message, action });
}
