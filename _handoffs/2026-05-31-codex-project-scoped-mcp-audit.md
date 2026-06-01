# Handoff: Codex project-scoped MCP support audit and implementation plan

**Date**: 2026-05-31
**Bridge/Scope**: Cross-bridge audit for `MCP-Servers/`, installer config writers, and support claims
**Status**: Audit complete, implementation plan proposed
**Severity**: High - current installer supports Claude project config, but Codex-native workspace scope is not implemented, which caused global/stale Codex MCP processes to shadow workspace intent.

---

## Executive decision

Add Codex-native project support by generating `<workspace>/.codex/config.toml` in addition to the existing Claude-compatible `.mcp.json` and `.mcp.local.json`.

Do not use `codex mcp add` as the durable project-scoped path. Local help exposes no `--scope` option for `codex mcp add`, and the official Codex docs say project-scoped MCP config is direct `config.toml` under `.codex/` for trusted projects.

Keep `.mcp.json` plus `.mcp.local.json` as the shared bridge configuration source. The Codex TOML should be a project-scoped launcher for Codex, not a second manual credential store.

No README or manifest should claim "Codex support" for a bridge until that bridge has all three:

1. Installer writes a valid `.codex/config.toml` entry for the bridge.
2. `install.mjs --doctor` can verify the Codex project entry and detect global conflicts.
3. A Codex discovery smoke has been run from a trusted workspace.

## Research basis

Official Codex docs:

- `https://developers.openai.com/codex/config-basic`
  - Codex reads user config from `~/.codex/config.toml`.
  - Project overrides live in `.codex/config.toml`.
  - Project `.codex/` layers only load for trusted projects.
  - Project config has higher precedence than user config.
- `https://developers.openai.com/codex/mcp`
  - Codex stores MCP configuration in `config.toml`.
  - MCP servers are configured as `[mcp_servers.<server-name>]`.
  - stdio server fields include `command`, `args`, `env`, `env_vars`, and `cwd`.
  - The IDE extension and CLI share config layers.
- `https://developers.openai.com/codex/config-reference`
  - Confirms `mcp_servers.<id>.command`, `args`, `cwd`, `env`, `env_vars`, `enabled`, `required`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools`, and per-tool approval keys.

Official Claude Code docs:

- `https://code.claude.com/docs/en/mcp`
  - Claude project-scoped MCP is `.mcp.json` at the project root.
  - Claude local/user scopes are stored in `~/.claude.json`.
  - Claude scope precedence is local, project, user, plugin-provided, then claude.ai connectors.
  - Claude prompts for approval before using project-scoped `.mcp.json` servers.
  - Claude supports environment expansion in `.mcp.json`.

Local CLI evidence:

- `codex mcp add --help` has `--env` and `--url`, but no `--scope`.
- `claude mcp add --help` has `--scope local|user|project`.
- `C:\Users\posne\.codex\config.toml` currently has a global `[mcp_servers.perforce]`, so a project without `.codex/config.toml` can attach to global Perforce instead of workspace Perforce.

## Current repo findings

### Finding 1 - Installer writes only Claude-style MCP config

Evidence:

- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:9` defines `.mcp.json`.
- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:10` defines `.mcp.local.json`.
- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:54` implements `setBridgeInConfig`.
- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:62` writes `cfg.public.mcpServers[bridgeName]`.
- `Installers/MCP-Suite/Scripts/install.mjs:1242` calls `setBridgeInConfig`.
- `Installers/MCP-Suite/Scripts/install.mjs:1261` writes only the workspace JSON config.

Impact:

- Claude Code can use generated project `.mcp.json`.
- Codex does not get a native project entry.
- Codex can keep using stale user/global MCP config in `~/.codex/config.toml`.

### Finding 2 - Runtime resolver is reusable for Codex, but only for AI-Tools bridges

Evidence:

- `MCP-Servers/lib/resolve-config.mjs:4-6` defines env, `PROJECT_ROOT`, and cwd walk-up tiers.
- `MCP-Servers/lib/resolve-config.mjs:14-15` hard-codes `.mcp.json` and `.mcp.local.json`.
- `MCP-Servers/lib/resolve-config.mjs:73-97` supports modern `bridges.<name>` and legacy `mcpServers.<name>.env`.
- `MCP-Servers/lib/resolve-config.mjs:122` exposes `resolveBridgeConfig`.
- Co-located bridge servers call `loadBridgeConfigOrExit(...)`.

Implication:

- For Perforce, Atlassian, Miro, Discord, and Otter, Codex can launch the bridge with only `PROJECT_ROOT=<workspace>`, and the bridge can load the existing Claude-compatible config plus local secrets.
- This avoids duplicating credentials into Codex TOML.

### Finding 3 - UEMCP is not equivalent to the co-located bridges

Evidence:

- `MCP-Servers/manifest.json:34-45` declares `uemcp` as a remote-repo bridge.
- Local `D:\DevTools\UEMCP\manifest.json` exists and has `main: "server/server.mjs"`.
- `D:\DevTools\UEMCP\server\server.mjs:85-117` reads `UNREAL_*` and `UEMCP_*` directly from launch environment.
- It does not use `MCP-Servers/lib/resolve-config.mjs`.

Implication:

- A Codex TOML entry with only `PROJECT_ROOT` is not enough for UEMCP today.
- UEMCP needs either:
  - full public env projection into `.codex/config.toml`, or
  - an upstream UEMCP config resolver that reads `.mcp.json`.
- Do not claim Codex parity for UEMCP until one of those paths is implemented and smoke-tested.

### Finding 4 - Support claims are currently mostly conservative, but some docs are stale

Evidence:

- `MCP-Servers/README.md:3` says "Claude Code and Cowork", not Codex.
- `MCP-Servers/README.md:10` says tools Claude can call.
- `MCP-Servers/README.md:17` says installer writes `.mcp.json` and `.mcp.local.json`.
- `MCP-Servers/README.md:28` says bridges become available when running `claude`.
- `MCP-Servers/manifest.json:5` says "Claude Code / Cowork".
- `MCP-Servers/bridges/perforce/package.json:4` says "Claude tools".
- `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md:117-127` claims the current root manifest declares a UEMCP `setup` block, but the actual `MCP-Servers/manifest.json` does not.

Required cleanup:

- Do not add Codex support claims until after implementation and validation.
- Replace "Claude tools" package language with "MCP tools".
- Either remove "Cowork" if it is no longer a verified client, or define exactly what client/version that term refers to.
- Fix the stale UEMCP manifest-spec section.

### Finding 5 - Remote bridge source metadata overstates implemented behavior

Evidence:

- `MCP-Servers/manifest.json:40-41` declares UEMCP `source.release = "latest"` and `source.subPath = "."`.
- `Installers/MCP-Suite/Scripts/install.mjs:208` and `Installers/MCP-Suite/Scripts/install.mjs:232` cache remote bridges under `bridgeVersionDir(bridgeName, "remote")`, not by release, tag, commit, or subpath.
- `Installers/MCP-Suite/Scripts/install.mjs:264-265` always downloads the latest release tarball, or falls back to the repo `HEAD` tarball.
- `Installers/MCP-Suite/Scripts/lib/github.mjs:37` exposes `getDefaultBranchHead`, but the installer fetch path does not use it for deterministic cache naming or support claims.

Impact:

- The root manifest currently describes a remote-source schema that is only partially implemented.
- `release: "latest"` is implemented in practice, but no other release selector is proven supported.
- `subPath: "."` happens to match the current behavior, but non-dot subpaths are not implemented.
- Codex config generation must use the actual resolved bridge directory returned by the installer, not trust unimplemented remote source fields.

Required cleanup:

- Before broadening Codex support to remote bridges, either implement and test `source.release` and `source.subPath`, or narrow the manifest/docs to the behavior the installer actually supports: latest release or HEAD fallback, repo root only.
- Add a doctor warning for remote bridge manifests that declare unsupported source fields.

### Finding 6 - Update mode is `.mcp.json`-canonical today

Evidence:

- `Installers/MCP-Suite/Update-MCP-Suite.bat:5` says update mode reads `.mcp.json` to determine enabled bridges.
- `Installers/MCP-Suite/Scripts/install.ps1:204-274` discovers enabled workspace bridges from `.mcp.json`.
- `Installers/MCP-Suite/Scripts/install.ps1:208-213` exits update mode when `.mcp.json` is missing.
- `Installers/MCP-Suite/Scripts/install.ps1:235` reads legacy `cfg.mcpServers`.

Impact:

- `.mcp.json` remains the installer source of truth for enabled bridge state.
- A Codex-only project file cannot safely replace `.mcp.json` unless update mode is redesigned.
- The planned `--codex-only` option should mean "regenerate `.codex/config.toml` from existing `.mcp.json`", not "make Codex TOML the canonical state file."

### Finding 7 - Bridge test coverage is uneven

Evidence from package and test inventory:

- `MCP-Servers/bridges/atlassian/package.json` has no `test` script and the bridge has zero `*.test.mjs` files.
- `MCP-Servers/bridges/miro/package.json` has no `test` script and the bridge has zero `*.test.mjs` files.
- Discord, Otter, and Perforce have `node --test` scripts and existing test files.

Impact:

- "Codex can discover all co-located bridges" would be an unproven claim for Atlassian and Miro until server discovery tests exist.
- Adding Codex project config without adding discovery tests risks repeating the stale-tool-surface failure in another client.

### Finding 8 - Codex project config will contain machine-local paths

Evidence:

- Official Codex config supports project `.codex/config.toml`, but the server launcher fields include local `command`, `args`, `cwd`, and `env`.
- This repo's installer resolves bridge server paths under the local AI-Tools checkout and writes workspace-specific project roots.

Impact:

- Generated `.codex/config.toml` is operational project config, but it may not be portable across teammates unless their AI-Tools checkout and workspace paths match.
- The implementation must make an explicit ownership decision before writing Codex files: generated local artifact, team-committed artifact, or hybrid.
- Regardless of that decision, secrets must stay out of Codex TOML.

Recommended default:

- Treat `.codex/config.toml` managed blocks as local generated installer state unless the team intentionally standardizes absolute paths.
- Preserve any existing project Codex config outside the managed block.
- Doctor should report whether the project Codex entry points at the current AI-Tools checkout.

## Bridge matrix

| Bridge | Repo status | Config behavior | Test status | Codex project support status |
|---|---:|---|---|---|
| `perforce` | Co-located | Shared resolver; optional `P4PASSWD`; admin writer runtime-gated by `P4_ENABLE_ADMIN` | `node --test`; parser and server tests present | Ready after Codex writer and smoke. Prefer `PROJECT_ROOT`-only Codex env so `.mcp.json` admin edits apply after restart. |
| `atlassian` | Co-located | Shared resolver first, legacy Jira/Confluence fallback after env injection; required secret token in `.mcp.local.json` | No test script; no `*.test.mjs` | Needs Codex writer plus basic discovery test before support claim. |
| `miro` | Co-located | Shared resolver first, legacy `.mcp.json` fallback after env injection; required secret token in `.mcp.local.json` | No test script; no `*.test.mjs` | Needs Codex writer plus basic discovery test before support claim. |
| `discord` | Co-located | Shared resolver; required bot token in `.mcp.local.json`; optional guild allowlist public | `node --test`; client and server tests present | Ready after Codex writer and smoke. |
| `otter` | Co-located | Shared resolver; required API key in `.mcp.local.json` | `node --test`; client and server tests present | Ready after Codex writer and smoke. |
| `uemcp` | Remote repo | Direct `process.env.UNREAL_*` and `UEMCP_*`; no shared resolver; remote source fields only partially honored by installer | Tests live in upstream repo; not covered by AI-Tools bridge test pass | Conditional. Needs full public-env Codex projection or UEMCP resolver, plus remote source schema cleanup, before support claim. |

## Implementation plan

### Task 0 - Lock config ownership and remote source semantics

**Files:**

- Modify: `MCP-Servers/manifest.json`
- Modify: `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md`
- Modify: installer docs after the Codex writer is implemented

Decisions to make before writing Codex TOML:

- `.mcp.json` remains the canonical installer state unless update mode is redesigned.
- `.codex/config.toml` is generated from `.mcp.json` plus resolved bridge install paths.
- `--codex-only` regenerates Codex project config from existing `.mcp.json`; it does not create a parallel source of truth.
- Generated Codex config is treated as local machine config unless the team chooses to standardize path layout.

Remote source cleanup:

- Either implement `source.release` and `source.subPath` fully, with tests, or remove/narrow those claims from docs.
- Until then, document the actual supported remote behavior: latest GitHub release tarball, fallback to repo `HEAD`, repo root only.
- Doctor must warn if a remote bridge manifest asks for source behavior the installer does not implement.

### Task 1 - Add Codex config writer tests

**Files:**

- Create: `Installers/MCP-Suite/Scripts/lib/codex-config.test.mjs`
- Create: `Installers/MCP-Suite/Scripts/lib/codex-config.mjs`

Write tests first for these cases:

- Missing `.codex/config.toml` creates `.codex/` and writes a managed AI-Tools block.
- Existing unrelated TOML content is preserved.
- Managed block replacement is idempotent.
- Disabled bridges are removed from the managed block.
- Secret field names and values are not written to Codex TOML.
- Windows paths are escaped correctly in TOML strings.
- An unmanaged `[mcp_servers.<bridge>]` table in the project file is reported as a conflict instead of producing duplicate TOML tables.
- Generated server `args` point at the installer-resolved bridge directory, not an unverified manifest path.
- `--codex-only` can regenerate the managed block from existing `.mcp.json` without prompting for secrets.

Recommended generated TOML shape for co-located AI-Tools bridges:

```toml
# BEGIN AI-Tools MCP Suite managed servers
[mcp_servers.perforce]
command = "node"
args = ["D:/DevTools/AI-Tools/MCP-Servers/bridges/perforce/server.mjs"]
cwd = "D:/UnrealProjects/5.6/OperationPhoenix"
enabled = true

[mcp_servers.perforce.env]
PROJECT_ROOT = "D:/UnrealProjects/5.6/OperationPhoenix"
# END AI-Tools MCP Suite managed servers
```

Recommended generated TOML shape for UEMCP until it has a shared resolver:

```toml
[mcp_servers.uemcp]
command = "node"
args = ["D:/DevTools/UEMCP/server/server.mjs"]
cwd = "D:/UnrealProjects/5.6/OperationPhoenix"
enabled = true

[mcp_servers.uemcp.env]
UNREAL_PROJECT_ROOT = "D:/UnrealProjects/5.6/OperationPhoenix/OnSight"
UNREAL_PROJECT_NAME = "OnSight"
UNREAL_TCP_PORT_CUSTOM = "55558"
UNREAL_TCP_TIMEOUT_MS = "10000"
UNREAL_RC_PORT = "30010"
UNREAL_AUTO_DETECT = "true"
PROJECT_ROOT = "D:/UnrealProjects/5.6/OperationPhoenix"
```

Conflict rule:

- If a matching `[mcp_servers.<bridge>]` table exists outside the managed block, do not overwrite it silently.
- Doctor should report it as `codex-conflict: unmanaged project table`.

### Task 2 - Implement `codex-config.mjs`

**Files:**

- Modify: `Installers/MCP-Suite/Scripts/lib/codex-config.mjs`

Required exports:

```js
export const CODEX_DIR = ".codex";
export const CODEX_CONFIG_FILE = "config.toml";
export const MANAGED_BEGIN = "# BEGIN AI-Tools MCP Suite managed servers";
export const MANAGED_END = "# END AI-Tools MCP Suite managed servers";

export function buildCodexManagedBlock(specs) {}
export function writeCodexWorkspaceConfig(workspaceDir, specs, opts = {}) {}
export function detectCodexProjectConflicts(configText, bridgeNames) {}
export function buildCodexSpecsFromWorkspaceConfig(workspaceDir, publicConfig, bridgeManifests) {}
```

Implementation notes:

- Use no new dependency unless the TOML writer becomes materially complex.
- Emit only strings, booleans, string arrays, and simple tables.
- Put AI-Tools generated tables in one managed block at the end of the file.
- Preserve all content outside the managed block byte-for-byte where practical.
- Reject duplicate unmanaged project tables for bridge names this installer manages.
- Keep secrets out. Only public values already present in `.mcp.json` may be projected.

### Task 3 - Add manifest metadata for Codex env strategy

**Files:**

- Modify: `MCP-Servers/bridges/perforce/manifest.json`
- Modify: `MCP-Servers/bridges/atlassian/manifest.json`
- Modify: `MCP-Servers/bridges/miro/manifest.json`
- Modify: `MCP-Servers/bridges/discord/manifest.json`
- Modify: `MCP-Servers/bridges/otter/manifest.json`
- Update the UEMCP manifest spec in `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md`

Recommended manifest addition for co-located bridges:

```json
"codex": {
  "envStrategy": "projectRootOnly"
}
```

Recommended manifest addition for UEMCP until it reads `.mcp.json` itself:

```json
"codex": {
  "envStrategy": "publicMcpServerEnv"
}
```

Strategy semantics:

- `projectRootOnly`: Codex TOML passes only `PROJECT_ROOT`; bridge loads `.mcp.json` and `.mcp.local.json`.
- `publicMcpServerEnv`: Codex TOML copies public `.mcp.json` `mcpServers.<name>.env` fields plus `PROJECT_ROOT`; secrets remain excluded.

Default:

- Treat missing `codex.envStrategy` as `publicMcpServerEnv` for remote bridges and `projectRootOnly` for co-located bridges only after tests confirm all co-located bridge servers import the shared resolver.

### Task 4 - Integrate Codex writing into install/update flow

**Files:**

- Modify: `Installers/MCP-Suite/Scripts/install.mjs`
- Modify: `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs` only if shared helpers are needed
- Modify: `Installers/MCP-Suite/Scripts/install.test.mjs`
- Modify: `Installers/MCP-Suite/Scripts/mcp-config.test.mjs` or add a new installer integration test

Flow:

1. Continue writing `.mcp.json` and `.mcp.local.json` first.
2. Build Codex specs from the final public config and bridge manifests.
3. Write `.codex/config.toml` managed block.
4. In non-interactive update mode, preserve bridges not explicitly selected the same way `.mcp.json` preservation works today.
5. In `--codex-only`, read the already-enabled bridge set from `.mcp.json`; fail with a clear message if `.mcp.json` is missing.
6. If Codex conflict detection fails, do not corrupt `.codex/config.toml`; print a warning and keep the Claude config write.

Add CLI options:

- `--skip-codex`: do not write `.codex/config.toml`.
- `--codex-only`: update `.codex/config.toml` from existing `.mcp.json` without prompting credentials.

Do not make Codex support depend on global `~/.codex/config.toml`.

### Task 5 - Extend doctor mode

**Files:**

- Modify: `Installers/MCP-Suite/Scripts/install.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install.test.mjs`

Doctor should report:

- `.mcp.json`: present/missing.
- `.mcp.local.json`: present/missing.
- `.codex/config.toml`: present/missing.
- For each bridge:
  - Claude config status from `.mcp.json`.
  - Codex project config status from `.codex/config.toml`.
  - Whether Codex env strategy is `projectRootOnly` or `publicMcpServerEnv`.
  - Whether a global duplicate exists in `~/.codex/config.toml`.
  - Whether an unmanaged project duplicate exists outside the managed block.

Suggested output categories:

- `ok`
- `missing-codex-project-config`
- `codex-global-duplicate`
- `codex-unmanaged-project-conflict`
- `codex-disabled`
- `codex-unsupported-until-smoke`

### Task 6 - Add bridge discovery smoke tests where missing

**Files:**

- Add tests for `MCP-Servers/bridges/atlassian/server.mjs`
- Add tests for `MCP-Servers/bridges/miro/server.mjs`
- Extend existing Perforce, Discord, and Otter server tests if they do not already assert basic MCP `tools/list`

Goal:

- Prove each co-located stdio server can start with dummy-but-complete config and expose its tool list.
- Do not call third-party APIs in these tests.
- Add `npm test` scripts for Atlassian and Miro when their first tests are added.

Acceptance:

- `npm test` succeeds in Atlassian, Discord, Miro, Otter, and Perforce.
- `node --test` in each bridge with tests.
- `node --check` on all tracked `.mjs`.

### Task 7 - Update support claims

**Files:**

- Modify: `MCP-Servers/README.md`
- Modify: `MCP-Servers/manifest.json`
- Modify: `MCP-Servers/bridges/perforce/package.json`
- Modify: `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md`
- Add Codex notes to bridge READMEs only after Codex validation is implemented.

Required wording discipline:

- Before implementation: "Codex project-scoped support planned."
- After TOML writer plus doctor: "Installer writes Codex project config."
- After discovery smoke: "Codex can discover this bridge from a trusted project."
- After credentialed tool call: "Codex validated for this bridge with real credentials."

Do not collapse those into a generic "Codex supported" claim.

### Task 8 - Verification matrix

Run after implementation:

```powershell
cd D:\DevTools\AI-Tools
node --test Installers/MCP-Suite/Scripts
cd D:\DevTools\AI-Tools\MCP-Servers\lib
node --test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\atlassian
npm test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\miro
npm test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\perforce
npm test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\discord
npm test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\otter
npm test
cd D:\DevTools\AI-Tools
git ls-files "MCP-Servers/**/*.mjs" "Installers/MCP-Suite/Scripts/**/*.mjs" | % { node --check $_ }
git diff --check
```

Project smoke from a trusted workspace:

```powershell
node D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:/UnrealProjects/5.6/OperationPhoenix
codex mcp list
codex mcp get perforce
```

Bridge-specific smoke:

- Perforce: `p4_bridge_status` must show the active `processId`, `projectRoot`, and expected `adminWritesEnabled`.
- Atlassian: discovery first; credentialed `connection_info` only when token is available.
- Miro: discovery first; credentialed `connection_info` only when token is available.
- Discord: discovery first; credentialed `connection_info` only when bot token is available.
- Otter: discovery first; credentialed `connection_info` only when API key is available.
- UEMCP: discovery plus `connection_info` against an editor state that is explicitly documented as running or not running.

## Immediate recommendation

Implement Tasks 1-5 first as one focused installer change. That fixes the systemic Codex project-scope problem without changing bridge tool behavior.

Then do Tasks 6-8 as a validation and claims-cleanup pass. Do not advertise Codex support broadly until the validation pass is green.
