// Installer config-wiring tests.
//
// These close the gap between "a manifest field exists" and "the bridge
// launches with it set". The Perforce bridge gates its admin WRITE tools on
// process.env.P4_ENABLE_ADMIN (server.mjs), and server.test.mjs already proves
// env -> tool-registration in both directions via spawned servers. The missing
// link was the installer half: does a collected field actually land in the
// launch env block (mcpServers.<name>.env) that becomes that process.env?
//
// setBridgeInConfig is the unit that performs that mapping, so we drive it
// directly with the real perforce manifest and assert the field flows through.
//
// Run with: `node --test` from Installers/MCP-Suite/Scripts/.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setBridgeInConfig, disableBridgeInConfig } from "./lib/mcp-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERFORCE_MANIFEST = resolve(__dirname, "../../../MCP-Servers/bridges/perforce/manifest.json");

function loadPerforceManifest() {
  return JSON.parse(readFileSync(PERFORCE_MANIFEST, "utf-8"));
}

// Fresh empty workspace-config shell, the shape loadWorkspaceConfig() returns
// for a workspace with no existing .mcp.json / .mcp.local.json.
function emptyCfg() {
  return {
    publicPath: "/tmp/ws/.mcp.json",
    secretPath: "/tmp/ws/.mcp.local.json",
    public: {},
    secrets: {},
    publicExisted: false,
    secretsExisted: false,
  };
}

describe("perforce manifest declares the admin opt-in safely", () => {
  it("has a P4_ENABLE_ADMIN field that is optional and defaults to 'false'", () => {
    const manifest = loadPerforceManifest();
    const field = manifest.fields.find((f) => f.name === "P4_ENABLE_ADMIN");
    assert.ok(field, "P4_ENABLE_ADMIN must be a declared manifest field");
    assert.equal(field.required, false, "must be optional so default installs don't prompt-block");
    assert.equal(field.secret, false, "it's not a secret — belongs in .mcp.json, not .mcp.local.json");
    // The security-critical invariant: a default install must be admin-writes-OFF.
    assert.equal(field.default, "false", "default MUST be 'false' (default install stays workspace-scoped)");
  });
});

describe("setBridgeInConfig wires P4_ENABLE_ADMIN into the launch env", () => {
  const serverPath = "/abs/MCP-Servers/bridges/perforce/server.mjs";

  it("places an opted-in value into mcpServers.perforce.env (the bridge's process.env at launch)", () => {
    const cfg = emptyCfg();
    const publicValues = {
      P4PORT: "ssl:p4:1666",
      P4USER: "me",
      P4CLIENT: "me_ws",
      P4DEPOT: "Depot/Proj",
      P4_ENABLE_ADMIN: "true", // operator opted in
    };
    setBridgeInConfig(cfg, "perforce", publicValues, {}, serverPath, { version: "1.0.0" });

    const env = cfg.public.mcpServers.perforce.env;
    assert.equal(env.P4_ENABLE_ADMIN, "true", "opted-in flag must reach the launch env block");
    // Sibling public fields ride along; PROJECT_ROOT fallback is injected too.
    assert.equal(env.P4PORT, "ssl:p4:1666");
    assert.ok(env.PROJECT_ROOT, "PROJECT_ROOT fallback should be present");
    // Mirror copy under bridges.<name> for the resolver's file tiers.
    assert.equal(cfg.public.bridges.perforce.P4_ENABLE_ADMIN, "true");
  });

  it("carries the manifest default through unchanged (off) when not opted in", () => {
    // Simulate the installer having resolved the field to its manifest default.
    const manifest = loadPerforceManifest();
    const def = manifest.fields.find((f) => f.name === "P4_ENABLE_ADMIN").default;

    const cfg = emptyCfg();
    const publicValues = {
      P4PORT: "ssl:p4:1666",
      P4USER: "me",
      P4CLIENT: "me_ws",
      P4DEPOT: "Depot/Proj",
      P4_ENABLE_ADMIN: def, // "false" from the manifest
    };
    setBridgeInConfig(cfg, "perforce", publicValues, {}, serverPath, { version: "1.0.0" });

    const env = cfg.public.mcpServers.perforce.env;
    assert.equal(env.P4_ENABLE_ADMIN, "false");
    // server.mjs only enables on the exact string "true", so "false" is OFF —
    // matching the default-off spawn assertion in the bridge's server.test.mjs.
    assert.notEqual(env.P4_ENABLE_ADMIN, "true");
  });

  it("does not invent the flag when the installer never collected it (back-compat)", () => {
    // Pre-existing installs that ran before the field existed simply won't have
    // it. The bridge treats absent as off, so nothing should fabricate it here.
    const cfg = emptyCfg();
    const publicValues = { P4PORT: "ssl:p4:1666", P4USER: "me", P4CLIENT: "me_ws", P4DEPOT: "Depot/Proj" };
    setBridgeInConfig(cfg, "perforce", publicValues, {}, serverPath, { version: "1.0.0" });

    const env = cfg.public.mcpServers.perforce.env;
    assert.ok(!("P4_ENABLE_ADMIN" in env), "flag must not be fabricated when uncollected");
  });

  it("drops the launch entry entirely when the bridge is disabled", () => {
    const cfg = emptyCfg();
    setBridgeInConfig(
      cfg,
      "perforce",
      { P4PORT: "ssl:p4:1666", P4USER: "me", P4CLIENT: "me_ws", P4DEPOT: "Depot/Proj", P4_ENABLE_ADMIN: "true" },
      {},
      serverPath,
      { enabled: false },
    );
    assert.ok(!cfg.public.mcpServers?.perforce, "disabled bridge should have no mcpServers launch entry");
  });
});

describe("disableBridgeInConfig preserves saved values but stops launch", () => {
  it("flips enabled:false and removes the launch entry", () => {
    const cfg = emptyCfg();
    setBridgeInConfig(
      cfg,
      "perforce",
      { P4PORT: "ssl:p4:1666", P4USER: "me", P4CLIENT: "me_ws", P4DEPOT: "Depot/Proj", P4_ENABLE_ADMIN: "true" },
      {},
      "/abs/server.mjs",
      {},
    );
    disableBridgeInConfig(cfg, "perforce");
    assert.ok(!cfg.public.mcpServers?.perforce, "launch entry removed");
    assert.equal(cfg.public.bridges.perforce.enabled, false, "enabled flag flipped off");
    // Saved value retained for a later re-enable.
    assert.equal(cfg.public.bridges.perforce.P4_ENABLE_ADMIN, "true");
  });
});
