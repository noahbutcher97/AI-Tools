import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatDoctorReport, runWorkspaceDoctor } from "./lib/doctor.mjs";

function manifest() {
  return {
    bridges: {
      sample: { displayName: "Sample", source: { type: "co-located", path: "bridges/sample" } },
    },
  };
}

function manifestWithUemcp() {
  return {
    bridges: {
      uemcp: { displayName: "UEMCP", source: { type: "co-located", path: "bridges/uemcp" } },
    },
  };
}

function withTempWorkspace(fn) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "mcp-doctor-test-"));
  try {
    return fn(workspaceDir);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeServerBundle(root, version = "1.0.0") {
  const bundleDir = join(root, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "server.mjs"), "console.log('sample bridge');\n", "utf-8");
  writeJson(join(bundleDir, "manifest.json"), {
    name: "sample",
    version,
    fields: [
      { name: "SAMPLE_PUBLIC", required: true, secret: false },
      { name: "SAMPLE_SECRET", required: true, secret: true },
    ],
  });
  return bundleDir;
}

function writeServerOnlyBundle(root) {
  const bundleDir = join(root, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "server.mjs"), "console.log('sample bridge');\n", "utf-8");
  return bundleDir;
}

describe("runWorkspaceDoctor", () => {
  it("reports missing public config", () => withTempWorkspace((workspaceDir) => {
    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 1);
    assert.equal(report.config.public.exists, false);
    assert.ok(report.issues.some((issue) => issue.code === "public-config-missing"));
  }));

  it("reports malformed public config as a parse failure", () => withTempWorkspace((workspaceDir) => {
    writeFileSync(join(workspaceDir, ".mcp.json"), "{", "utf-8");

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 2);
    assert.ok(report.issues.some((issue) => issue.code === "config-parse-failed"));
    assert.deepEqual(report.bridges, []);
  }));

  it("reports a launch entry with no server path argument", () => withTempWorkspace((workspaceDir) => {
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: ["--enable-source-maps"],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 1);
    assert.ok(report.issues.some((issue) => issue.code === "server-arg-missing"));
  }));

  it("reports an enabled bridge with a missing server path", () => withTempWorkspace((workspaceDir) => {
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: [join(workspaceDir, "missing", "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 1);
    assert.equal(report.bridges.find((bridge) => bridge.name === "sample").status, "enabled");
    assert.ok(report.issues.some((issue) => issue.code === "server-path-missing"));
  }));

  it("reports a disabled bridge that still has a launch entry", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerBundle(workspaceDir);
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: false, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });
    writeJson(join(workspaceDir, ".mcp.local.json"), {
      bridges: {
        sample: { SAMPLE_SECRET: "secret" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });
    const bridge = report.bridges.find((entry) => entry.name === "sample");

    assert.equal(report.exitCode, 1);
    assert.equal(bridge.status, "conflict");
    assert.equal(bridge.facts.manifestVersion, "1.0.0");
    assert.ok(bridge.issues.some((issue) => issue.code === "disabled-launch-present"));
  }));

  it("reports a missing required secret from the bridge manifest", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerBundle(workspaceDir);
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 1);
    assert.ok(report.issues.some((issue) => issue.code === "missing-secret"));
  }));

  for (const missingValue of [null, false, 0, "", "   ", [], {}]) {
    it(`treats ${JSON.stringify(missingValue)} secrets as missing required fields`, () => withTempWorkspace((workspaceDir) => {
      const bundleDir = writeServerBundle(workspaceDir);
      writeJson(join(workspaceDir, ".mcp.json"), {
        mcpServers: {
          sample: {
            command: "node",
            args: [join(bundleDir, "server.mjs")],
            env: { SAMPLE_PUBLIC: "public" },
          },
        },
        bridges: {
          sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
        },
      });
      writeJson(join(workspaceDir, ".mcp.local.json"), {
        bridges: {
          sample: { SAMPLE_SECRET: missingValue },
        },
      });

      const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

      assert.equal(report.exitCode, 1);
      assert.ok(report.issues.some((issue) => issue.code === "missing-secret"));
    }));
  }

  it("runs UEMCP checks for enabled UEMCP even when launch entry is missing", () => withTempWorkspace((workspaceDir) => {
    writeJson(join(workspaceDir, ".mcp.json"), {
      bridges: {
        uemcp: { enabled: true, version: "1.0.0" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifestWithUemcp() });
    const bridge = report.bridges.find((entry) => entry.name === "uemcp");

    assert.equal(report.exitCode, 1);
    assert.ok(bridge.issues.some((issue) => issue.code === "launch-entry-missing"));
    assert.ok(bridge.issues.some((issue) => issue.code === "uemcp-project-config-missing"));
    assert.ok(report.issues.some((issue) => issue.bridge === "uemcp" && issue.code === "launch-entry-missing"));
    assert.ok(report.issues.some((issue) => issue.bridge === "uemcp" && issue.code === "uemcp-project-config-missing"));
  }));

  it("allows simple Node flags before the server script argument", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerBundle(workspaceDir);
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: ["--enable-source-maps", join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });
    writeJson(join(workspaceDir, ".mcp.local.json"), {
      bridges: {
        sample: { SAMPLE_SECRET: "secret" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 0);
    assert.ok(!report.issues.some((issue) => issue.code === "server-path-missing"));
  }));

  it("skips value operands for common Node flags before the server script argument", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerBundle(workspaceDir);
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: ["--require", "dotenv/config", "--env-file", ".env", "--import", "./bootstrap.mjs", "--loader", "tsx", join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });
    writeJson(join(workspaceDir, ".mcp.local.json"), {
      bridges: {
        sample: { SAMPLE_SECRET: "secret" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });
    const bridge = report.bridges.find((entry) => entry.name === "sample");

    assert.equal(report.exitCode, 0);
    assert.equal(bridge.facts.serverPath, join(bundleDir, "server.mjs"));
  }));

  it("reports an existing server path with no nearby manifest", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerOnlyBundle(workspaceDir);
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });
    const bridge = report.bridges.find((entry) => entry.name === "sample");

    assert.equal(report.exitCode, 1);
    assert.ok(bridge.issues.some((issue) => issue.code === "manifest-missing"));
  }));

  it("reports a malformed nearby manifest as a parse failure", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerOnlyBundle(workspaceDir);
    const manifestPath = join(bundleDir, "manifest.json");
    writeFileSync(manifestPath, "{", "utf-8");
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });
    const bridge = report.bridges.find((entry) => entry.name === "sample");

    assert.equal(report.exitCode, 1);
    assert.ok(bridge.issues.some((issue) => issue.code === "manifest-parse-failed" && issue.path === manifestPath && issue.severity === "error"));
    assert.ok(!bridge.issues.some((issue) => issue.code === "manifest-missing"));
  }));

  it("reports version mismatch and includes it in the formatted report", () => withTempWorkspace((workspaceDir) => {
    const bundleDir = writeServerBundle(workspaceDir, "2.0.0");
    writeJson(join(workspaceDir, ".mcp.json"), {
      mcpServers: {
        sample: {
          command: "node",
          args: [join(bundleDir, "server.mjs")],
          env: { SAMPLE_PUBLIC: "public" },
        },
      },
      bridges: {
        sample: { enabled: true, version: "1.0.0", SAMPLE_PUBLIC: "public" },
      },
    });
    writeJson(join(workspaceDir, ".mcp.local.json"), {
      bridges: {
        sample: { SAMPLE_SECRET: "secret" },
      },
    });

    const report = runWorkspaceDoctor({ workspaceDir, rootManifest: manifest() });

    assert.equal(report.exitCode, 1);
    assert.ok(report.bridges.find((bridge) => bridge.name === "sample").issues.some((issue) => issue.code === "version-mismatch"));
    assert.match(formatDoctorReport(report), /version-mismatch/);
  }));
});
