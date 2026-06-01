import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(__dirname, "install.mjs");

function withTempFixture(fn) {
  const dir = join(tmpdir(), `install-cli-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workspaceDir = join(dir, "workspace");
  const mcpRoot = join(dir, "MCP-Servers");
  try {
    mkdirSync(workspaceDir, { recursive: true });
    writeMcpRoot(mcpRoot);
    return fn({ dir, workspaceDir, mcpRoot });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMcpRoot(mcpRoot, opts = {}) {
  const bridgeDir = join(mcpRoot, "bridges", "sample");
  mkdirSync(bridgeDir, { recursive: true });
  writeJson(join(mcpRoot, "manifest.json"), {
    schemaVersion: "1.0",
    version: "0.0.0-test",
    bridges: {
      sample: {
        displayName: "Sample",
        summary: "Fixture bridge",
        source: { type: "co-located", path: "bridges/sample" },
        ...(opts.setup ? { setup: opts.setup } : {}),
      },
    },
  });
  writeFileSync(join(bridgeDir, "server.mjs"), "console.log('sample bridge');\n", "utf-8");
  writeJson(join(bridgeDir, "manifest.json"), {
    name: "sample",
    version: opts.version || "1.0.0",
    main: "server.mjs",
    fields: [
      { name: "SAMPLE_PUBLIC", label: "Sample public", required: true, secret: false },
    ],
    ...(opts.postSetup ? { postSetup: opts.postSetup } : {}),
  });
  if (opts.packageJson) {
    writeJson(join(bridgeDir, "package.json"), opts.packageJson);
  }
  if (opts.postSetup?.command && opts.writePostSetup !== false) {
    writeFileSync(join(bridgeDir, opts.postSetup.command), "process.exit(7);\n", "utf-8");
  }
  if (opts.setup?.command && opts.writeSetup !== false) {
    const body = opts.setupScriptBody || "process.exit(7);\n";
    writeFileSync(join(bridgeDir, opts.setup.command), body, "utf-8");
  }
}

function runInstaller(mcpRoot, args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: __dirname,
    encoding: "utf-8",
    env: {
      ...process.env,
      MCP_SERVERS_ROOT: mcpRoot,
      MCP_INSTALLER_HEADER_SHOWN: "1",
    },
  });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function receiptFiles(workspaceDir) {
  const dir = join(workspaceDir, ".mcp-install-receipts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
}

function readOnlyReceipt(workspaceDir) {
  const files = receiptFiles(workspaceDir);
  assert.equal(files.length, 1);
  return JSON.parse(readFileSync(files[0], "utf-8"));
}

describe("installer CLI result accounting", () => {
  it("returns a usage error for unknown requested bridges", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=bogus",
      "--non-interactive",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown bridge name/);
    assert.equal(receiptFiles(workspaceDir).length, 0);
  }));

  it("returns a usage error without mutating malformed workspace config", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    const publicPath = join(workspaceDir, ".mcp.json");
    const invalidJson = "{ invalid json";
    writeFileSync(publicPath, invalidJson, "utf-8");

    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /could not be parsed/);
    assert.equal(readFileSync(publicPath, "utf-8"), invalidJson);
    assert.equal(receiptFiles(workspaceDir).length, 0);
  }));

  it("writes a receipt and exits zero for a successful non-interactive install", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = readOnlyReceipt(workspaceDir);
    assert.equal(receipt.mode, "install");
    assert.equal(receipt.exitCode, 0);
    assert.deepEqual(receipt.selectedBridges, ["sample"]);
    assert.equal(receipt.bridgeResults[0].bridge, "sample");
    assert.equal(receipt.bridgeResults[0].status, "ok");
    assert.equal(receipt.summary.byStatus.ok, 1);
  }));

  it("records post-setup failure as a partial result and exit one", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    writeMcpRoot(mcpRoot, {
      postSetup: {
        command: "fail-post.mjs",
        args: [],
        description: "Failing post setup",
      },
    });

    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 1);
    const receipt = readOnlyReceipt(workspaceDir);
    assert.equal(receipt.exitCode, 1);
    assert.equal(receipt.bridgeResults[0].status, "partial");
    assert.equal(receipt.bridgeResults[0].stages.postSetup.status, "failed");
    assert.match(receipt.nextSteps[0], /--doctor/);
  }));

  it("records missing declared post-setup script as a partial result", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    writeMcpRoot(mcpRoot, {
      postSetup: {
        command: "missing-post.mjs",
        args: [],
      },
      writePostSetup: false,
    });

    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 1);
    const receipt = readOnlyReceipt(workspaceDir);
    assert.equal(receipt.bridgeResults[0].status, "partial");
    assert.equal(receipt.bridgeResults[0].stages.postSetup.status, "failed");
    assert.match(receipt.bridgeResults[0].stages.postSetup.message, /not found/i);
  }));

  it("records missing declared own setup script as a failed result", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    writeMcpRoot(mcpRoot, {
      setup: {
        command: "missing-setup.mjs",
        args: ["{WORKSPACE}"],
      },
      writeSetup: false,
    });

    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 1);
    const receipt = readOnlyReceipt(workspaceDir);
    assert.equal(receipt.bridgeResults[0].status, "failed");
    assert.equal(receipt.bridgeResults[0].stages.setup.status, "failed");
    assert.match(receipt.bridgeResults[0].stages.setup.message, /not found/i);
  }));

  it("records dependency bootstrap failure as a partial result", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    writeMcpRoot(mcpRoot, {
      packageJson: {
        dependencies: {
          "definitely-not-a-real-package-ai-tools-test": "0.0.0",
        },
      },
    });

    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 1);
    const receipt = readOnlyReceipt(workspaceDir);
    assert.equal(receipt.bridgeResults[0].status, "partial");
    assert.equal(receipt.bridgeResults[0].stages.source.status, "partial");
    assert.equal(receipt.bridgeResults[0].stages.source.depInstallFailures.length > 0, true);
  }));

  it("does not let successful own setup mask dependency bootstrap failure", () => withTempFixture(({ workspaceDir, mcpRoot }) => {
    writeMcpRoot(mcpRoot, {
      setup: {
        command: "setup-ok.mjs",
        args: ["{WORKSPACE}"],
      },
      setupScriptBody: "process.exit(0);\n",
      packageJson: {
        dependencies: {
          "definitely-not-a-real-package-ai-tools-test": "0.0.0",
        },
      },
    });

    const result = runInstaller(mcpRoot, [
      `--workspace=${workspaceDir}`,
      "--bridges=sample",
      "--non-interactive",
      "--field=SAMPLE_PUBLIC=value",
    ]);

    assert.equal(result.status, 1);
    const receipt = readOnlyReceipt(workspaceDir);
    assert.equal(receipt.bridgeResults[0].status, "partial");
    assert.equal(receipt.bridgeResults[0].stages.setup.status, "ok");
    assert.equal(receipt.bridgeResults[0].stages.source.status, "partial");
  }));
});
