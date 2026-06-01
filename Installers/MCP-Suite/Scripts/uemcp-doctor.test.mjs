import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatDoctorReport, runWorkspaceDoctor } from "./lib/doctor.mjs";
import { evaluateUemcpHealth } from "./lib/uemcp-doctor.mjs";

const REQUIRED_DEPS = ["RemoteControl", "PythonScriptPlugin", "GeometryScripting"];

function withTempWorkspace(fn) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "uemcp-doctor-test-"));
  try {
    return fn(workspaceDir);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeBundle(workspaceDir, opts = {}) {
  const bundleDir = join(workspaceDir, "cache", "uemcp");
  mkdirSync(join(bundleDir, "server"), { recursive: true });
  writeFileSync(join(bundleDir, "server", "server.mjs"), "console.log('uemcp');\n", "utf-8");
  writeJson(join(bundleDir, "manifest.json"), {
    name: "uemcp",
    version: opts.version || "1.0.13",
    fields: [
      { name: "UNREAL_TCP_TIMEOUT_MS", required: false, secret: false, default: opts.defaultTimeout || "10000" },
    ],
  });
  return {
    manifestPath: join(bundleDir, "manifest.json"),
    serverPath: join(bundleDir, "server", "server.mjs"),
  };
}

function writeGame(workspaceDir, opts = {}) {
  const projectRoot = join(workspaceDir, "Game");
  const pluginRoot = join(projectRoot, "Plugins", "UEMCP");
  mkdirSync(join(pluginRoot, "Binaries", "Win64"), { recursive: true });

  if (opts.projectJson !== false) {
    writeJson(join(projectRoot, "Game.uproject"), {
      FileVersion: 3,
      Plugins: (opts.projectDeps || REQUIRED_DEPS).map((name) => ({ Name: name, Enabled: true })),
    });
  }

  if (opts.uplugin !== false) {
    writeJson(join(pluginRoot, "UEMCP.uplugin"), {
      FileVersion: 3,
      VersionName: opts.pluginVersion || "1.0.13",
    });
  }

  if (opts.marker !== false) {
    writeJson(join(pluginRoot, ".uemcp-deploy-marker.json"), {
      manifestVersion: opts.markerVersion || "1.0.13",
    });
  }

  if (opts.dll !== false) {
    writeFileSync(join(pluginRoot, "Binaries", "Win64", "UnrealEditor-UEMCP.dll"), "fixture dll\n", "utf-8");
  }

  return projectRoot;
}

function cfg(projectRoot, opts = {}) {
  return {
    public: {
      mcpServers: {
        uemcp: {
          env: {
            UNREAL_PROJECT_ROOT: projectRoot,
            UNREAL_PROJECT_NAME: "Game",
            ...(opts.env || {}),
          },
        },
      },
      bridges: {
        uemcp: {
          enabled: true,
          version: opts.bridgeVersion || "1.0.13",
          ...(opts.bridgeRecord || {}),
        },
      },
    },
  };
}

function bridge(facts) {
  return {
    name: "uemcp",
    facts,
    issues: [],
  };
}

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

describe("evaluateUemcpHealth", () => {
  it("reports server bundle and deployed plugin version mismatch", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir, { version: "1.0.4" });
    const projectRoot = writeGame(workspaceDir, { markerVersion: "1.0.13", pluginVersion: "1.0.13" });

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot, { bridgeVersion: "1.0.4" }),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.4", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-version-mismatch"));
    assert.equal(result.facts.configuredServerVersion, "1.0.4");
    assert.equal(result.facts.deployMarkerVersion, "1.0.13");
  }));

  it("reports configured timeout drift from the located bundle manifest default", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir, { defaultTimeout: "10000" });
    const projectRoot = writeGame(workspaceDir);

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot, { env: { UNREAL_TCP_TIMEOUT_MS: "5000" } }),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.13", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-timeout-drift"));
    assert.equal(result.facts.configuredTimeout, "5000");
    assert.equal(result.facts.defaultTimeout, "10000");
  }));

  it("reports missing required project plugin dependencies", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir);
    const projectRoot = writeGame(workspaceDir, { projectDeps: ["RemoteControl"] });

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.13", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-needs-project-deps"));
  }));

  it("reports missing deploy marker", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir);
    const projectRoot = writeGame(workspaceDir, { marker: false });

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.13", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-needs-sync"));
  }));

  it("reports missing editor DLL", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir);
    const projectRoot = writeGame(workspaceDir, { dll: false });

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.13", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-needs-build"));
  }));

  it("reports a stale editor DLL when plugin source is newer than the built DLL", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir);
    const projectRoot = writeGame(workspaceDir);
    const pluginRoot = join(projectRoot, "Plugins", "UEMCP");
    const sourcePath = join(pluginRoot, "Source", "UEMCP", "Private", "Fixture.cpp");
    const dllPath = join(pluginRoot, "Binaries", "Win64", "UnrealEditor-UEMCP.dll");
    mkdirSync(join(pluginRoot, "Source", "UEMCP", "Private"), { recursive: true });
    writeFileSync(sourcePath, "// newer than dll\n", "utf-8");
    utimesSync(dllPath, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(sourcePath, new Date("2026-01-01T00:01:00Z"), new Date("2026-01-01T00:01:00Z"));

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.13", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-build-stale"));
    assert.deepEqual(result.facts.staleBuildInputs, [sourcePath]);
  }));

  it("returns no UEMCP issues when versions, timeout, dependencies, marker, descriptor, and DLL match", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir, { version: "1.0.13", defaultTimeout: "10000" });
    const projectRoot = writeGame(workspaceDir, { markerVersion: "1.0.13", pluginVersion: "1.0.13" });

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot, { env: { UNREAL_TCP_TIMEOUT_MS: "10000" } }),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.13", serverPath: bundle.serverPath }),
    });

    assert.deepEqual(result.issues, []);
    assert.equal(result.facts.projectRoot, projectRoot);
    assert.equal(result.facts.pluginVersion, "1.0.13");
    assert.equal(result.facts.deployMarkerVersion, "1.0.13");
  }));

  it("reports marker and plugin descriptor version drift even when the configured server matches the marker", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir, { version: "1.0.4" });
    const projectRoot = writeGame(workspaceDir, { markerVersion: "1.0.4", pluginVersion: "1.0.13" });

    const result = evaluateUemcpHealth({
      cfg: cfg(projectRoot, { bridgeVersion: "1.0.4" }),
      bridge: bridge({ manifestPath: bundle.manifestPath, manifestVersion: "1.0.4", serverPath: bundle.serverPath }),
    });

    assert.ok(issueCodes(result).includes("uemcp-version-mismatch"));
    assert.equal(result.facts.configuredServerVersion, "1.0.4");
    assert.equal(result.facts.deployMarkerVersion, "1.0.4");
    assert.equal(result.facts.pluginVersion, "1.0.13");
  }));

  it("aggregates UEMCP issues through runWorkspaceDoctor and formatted output", () => withTempWorkspace((workspaceDir) => {
    const bundle = writeBundle(workspaceDir, { version: "1.0.4", defaultTimeout: "10000" });
    const projectRoot = writeGame(workspaceDir, { markerVersion: "1.0.13", pluginVersion: "1.0.13", dll: false });
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        uemcp: {
          command: "node",
          args: [bundle.serverPath],
          env: {
            UNREAL_PROJECT_ROOT: projectRoot,
            UNREAL_PROJECT_NAME: "Game",
            UNREAL_TCP_TIMEOUT_MS: "5000",
          },
        },
      },
      bridges: {
        uemcp: {
          enabled: true,
          version: "1.0.4",
        },
      },
    });

    const report = runWorkspaceDoctor({
      workspaceDir,
      rootManifest: { bridges: { uemcp: { displayName: "UEMCP" } } },
    });
    const formatted = formatDoctorReport(report);

    assert.equal(report.exitCode, 1);
    assert.ok(report.issues.some((issue) => issue.bridge === "uemcp" && issue.code === "uemcp-version-mismatch"));
    assert.ok(report.issues.some((issue) => issue.bridge === "uemcp" && issue.code === "uemcp-timeout-drift"));
    assert.ok(report.issues.some((issue) => issue.bridge === "uemcp" && issue.code === "uemcp-needs-build"));
    assert.match(formatted, /uemcp-version-mismatch/);
    assert.match(formatted, /uemcp-timeout-drift/);
    assert.match(formatted, /uemcp-needs-build/);
  }));
});
