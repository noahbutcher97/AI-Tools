# Handoff: MCP Suite installer broad audit

**Date**: 2026-05-31
**Scope**: `Installers/MCP-Suite/`, `MCP-Servers/`, current workspace configs, and local `D:/DevTools/UEMCP`
**Status**: Audit complete, implementation plan proposed
**Mode**: Read-only audit. No installer or bridge runtime code changed.

## Follow-up status

The Phase 1 observability slice from this audit was implemented in commit `1965686` (`installer: add result accounting doctor`). Historical findings below still describe the pre-fix baseline from 2026-05-31; remaining open areas include Codex project config generation, UEMCP first-time setup parity, remote cache identity, and live MCP client discovery.

## Executive summary

The installer is useful and has several solid foundations: workspace-local config, secret split, merge-preserving writes for normal JSON, dependency bootstrapping, bridge validation, and guarded setup/post-setup script execution.

The main problem is that the installer currently proves far less than it claims. The biggest risk is UEMCP: OperationPhoenix is configured to launch an old cached UEMCP server (`1.0.4`) while the deployed plugin and local UEMCP repo are `1.0.13`. Doctor reports only "enabled" and does not flag that mismatch. The central installer also runs UEMCP `sync-plugin.bat`, not the full `setup-uemcp.bat` path, so it does not perform every project setup step that the UEMCP repo's own setup script performs.

Before adding more client support or support claims, fix installer observability and UEMCP parity first. The correct next implementation slice is doctor/source-state hardening, not new features.

## What works today

- `setBridgeInConfig` preserves unrelated bridge entries and writes a public `.mcp.json` plus secret `.mcp.local.json`.
- Secrets are not copied into `.mcp.json`; `ensureSecretIgnored` adds `.mcp.local.json` to relevant ignore files.
- Co-located bridge dependency install is idempotent in the Node installer through lockfile hashing.
- Bridge validation supports HTTP and command checks with command allowlisting.
- Post-setup script execution has useful guardrails: plain filename, extension allowlist, bridge-dir anchoring, array args, and no `shell:true`.
- UEMCP's own repo is internally healthy under its current test rotation: `npm test` in `D:/DevTools/UEMCP/server` passed `2201/2201` assertions, with four env/live-gated skips.
- `sync-plugin.bat` has good deploy-marker and per-workspace editor-lock hardening.

## Findings

### Finding 1 - UEMCP server cache can drift from the deployed plugin

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:208` resolves every remote bridge to `bridgeVersionDir(bridgeName, "remote")`.
- `Installers/MCP-Suite/Scripts/install.mjs:264-265` fetches latest GitHub release, or falls back to repo `HEAD`.
- Current GitHub API check on 2026-05-31 returned `404` for `https://api.github.com/repos/noahbutcher97/UEMCP/releases/latest`.
- Current GitHub default branch HEAD was `f8e33a1897b85c12ae324f74f57041a87c35e510` on `main`.
- Current cache at `C:/Users/posne/AppData/Local/mcp-bridges/bridges/uemcp/remote/manifest.json` is UEMCP `1.0.4`, last written `2026-05-06`.
- Local `D:/DevTools/UEMCP/manifest.json` is `1.0.13`.
- Deployed OperationPhoenix plugin marker is `manifestVersion: "1.0.13"`.
- `D:/UnrealProjects/5.6/OperationPhoenix/.mcp.json` still launches `C:/Users/posne/AppData/Local/mcp-bridges/bridges/uemcp/remote/server/server.mjs` and records `bridges.uemcp.version = "1.0.4"`.

Impact:

- The active MCP server can be older than the deployed UEMCP plugin.
- Tool schema, wire protocol, timeout, and dynamic-tool behavior can silently mismatch.
- Doctor reports UEMCP as enabled instead of stale or mismatched.

Required fix:

- Cache remote bridges by a real source identity: release tag, commit SHA, or explicit local override path.
- When no GitHub release exists, use `getDefaultBranchHead` and cache under the HEAD SHA instead of the fixed `"remote"` directory.
- Store the resolved source identity in `.mcp.json` metadata.
- Doctor must compare configured server path, cached manifest version, deployed plugin marker, and upstream/local UEMCP source state.

### Finding 2 - Central UEMCP install is not equivalent to UEMCP's own setup

**Severity**: High

Evidence:

- `MCP-Servers/manifest.json:34-45` declares UEMCP as a remote repo with no `setup.command`.
- Local `D:/DevTools/UEMCP/manifest.json:93-97` declares only `postSetup.command = "sync-plugin.bat"`.
- `Installers/MCP-Suite/Scripts/install.mjs:1247-1257` runs `postSetup` after setting in-memory config.
- `D:/DevTools/UEMCP/sync-plugin.bat:220-326` copies plugin source and writes a deploy marker.
- `D:/DevTools/UEMCP/setup-uemcp.bat:407-452` additionally edits the target `.uproject` to add or enable `RemoteControl`, `PythonScriptPlugin`, and `GeometryScripting`, and removes stale `Blutility`.
- Current `D:/UnrealProjects/5.6/OperationPhoenix/OnSight/OnSight.uproject` does not list `RemoteControl`, `PythonScriptPlugin`, or `GeometryScripting`.

Impact:

- The central installer can report UEMCP post-setup success after only copying the plugin.
- It does not run every setup step that UEMCP's own setup path treats as required.
- `verify-deploy` can still report `ALL-SYNC` because it checks source/deploy/build freshness, not target `.uproject` dependency state.

Required fix:

- Choose one of two durable paths:
  - Make the central installer run UEMCP's full setup entrypoint with a real supported interface, or
  - Move the required `.uproject` dependency edit into `sync-plugin.bat` or a new manifest-driven post-setup helper, then test it.
- Add UEMCP doctor checks for target `.uproject` dependency state.
- Do not call central UEMCP install "complete" until config, plugin copy, dependency state, and deploy-marker state are all checked.

### Finding 3 - Doctor is too shallow to verify installer correctness

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:982-1001` only reports `.mcp.json` presence, layout, and enabled/absent/disabled per bridge.
- It does not check server path existence, package deps, manifest version, config parse health beyond presence, secret presence, stale cache, remote source identity, Codex config, UEMCP plugin deploy, `.uproject` dependencies, or validation freshness.
- Live doctor against OperationPhoenix reported UEMCP as `enabled` even though the configured UEMCP server cache is `1.0.4` and the deployed plugin is `1.0.13`.
- Live doctor against AI-Tools itself returned only "No .mcp.json found", with no suggestion of Codex config, global conflicts, or project-scoped state.

Impact:

- The primary "health check" does not answer whether the installer did its job.
- Drift remains invisible until an MCP client exposes stale tools or fails at runtime.

Required fix:

- Expand doctor into a real state audit with per-bridge checks:
  - config parse result and backups
  - public and secret field presence
  - command/args path exists
  - bridge manifest version vs recorded version
  - package deps present or dry-run status
  - remote source identity and cache freshness
  - Codex project/global duplicate state
  - UEMCP plugin deployment marker and `.uproject` dependency state
  - action-oriented verdicts: `ok`, `missing`, `stale-cache`, `server-path-missing`, `config-drift`, `needs-update`, `needs-sync`, `needs-build`, `needs-project-deps`

### Finding 4 - Invalid existing JSON can be overwritten

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:13-20` logs a parse error and returns `null`.
- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:24-34` converts that `null` into `{}` while still remembering that the file existed.
- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:116-122` later writes the public config back.

Impact:

- A malformed `.mcp.json` or `.mcp.local.json` can be treated like an empty config.
- A subsequent install can overwrite damaged-but-recoverable user config instead of stopping.
- This conflicts with the repo rule that installer changes must preserve existing workspace config.

Required fix:

- Split "missing" from "parse failed" in `loadWorkspaceConfig`.
- Abort install/update on parse failure unless an explicit repair/overwrite flag is provided.
- Doctor should report parse failures with backup and repair instructions.

### Finding 5 - Post-setup ordering and docs are wrong

**Severity**: Medium

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:902` says post-setup runs after config is gathered and saved.
- `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md:146-153` also says the installer saves `.mcp.json`, then runs `postSetup`.
- Actual code calls `setBridgeInConfig` at `Installers/MCP-Suite/Scripts/install.mjs:1242`, runs `postSetup` at `1250-1257`, and writes files only at `1261`.

Impact:

- Scripts or docs can incorrectly rely on `.mcp.json` already being saved.
- If post-setup succeeds but final config write fails, the project may have deployed artifacts without a matching config.
- If post-setup fails, config is still written afterward, which may be intentional but should be explicitly reported as a partial install.

Required fix:

- Decide the intended transaction order:
  - save config before post-setup and mark partial install if post-setup fails, or
  - run post-setup first and only save config after all required setup steps pass.
- Update docs and tests to match the chosen behavior.

### Finding 6 - PowerShell front end has duplicate and weaker dependency logic

**Severity**: Medium

Evidence:

- `Installers/MCP-Suite/Scripts/install.ps1:186-199` runs `npm ci` for every co-located bridge with `package.json` and no `node_modules`, before the user selects bridges.
- The Node installer already installs selected bridge deps through `installNodeDepsRecursive`.
- The PowerShell path does not use the `.npm-deps-state.json` lock-hash skip logic from `Installers/MCP-Suite/Scripts/install.mjs:353-457`.

Impact:

- Double-click install can do unnecessary work before the user has chosen bridges.
- A failing unselected bridge dependency install can confuse the front-end path.
- The two dependency paths can drift in behavior.

Required fix:

- Remove the PowerShell all-bridge dependency install, or make it call a shared Node bootstrap command.
- Let the Node installer own dependency resolution for selected bridges only.

### Finding 7 - Node minimum version is declared but not enforced

**Severity**: Medium

Evidence:

- `MCP-Servers/manifest.json` declares `minNodeVersion: "18.0.0"`.
- `Installers/MCP-Suite/Scripts/install.ps1:50-86` checks only that `node` exists.
- `Installers/MCP-Suite/Scripts/install.mjs` does not compare `process.versions.node` to the manifest minimum.

Impact:

- Users with an older Node can get runtime syntax or API failures instead of a clear installer error.
- The code relies on modern Node behavior such as global `fetch` and `AbortSignal.timeout`.

Required fix:

- Enforce `minNodeVersion` in both the PowerShell wrapper and Node entrypoint.
- Print the installed version and required version in failure output.

### Finding 8 - UEMCP auto-detect is too implicit for multi-project workspaces

**Severity**: Medium

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:505-529` does a shallow BFS and returns the first `.uproject` found.
- UEMCP's own `setup-uemcp.bat:170-251` explicitly asks for a `.uproject` in interactive mode and derives workspace/project from that chosen file.

Impact:

- A workspace with multiple `.uproject` files can be configured for the wrong project.
- The central installer asks for workspace folder first but does not give UEMCP a project picker equivalent to UEMCP's own setup.

Required fix:

- Add field-level auto-detect choices for `.uproject` fields, or a UEMCP-specific project picker before writing config.
- In non-interactive mode, require explicit `UNREAL_PROJECT_ROOT` and `UNREAL_PROJECT_NAME` when multiple candidates exist.

### Finding 9 - Support docs contain stale or overbroad claims

**Severity**: Medium

Evidence:

- `MCP-Servers/README.md:14` says one fetch per release, but UEMCP currently has no GitHub release and is cached under a fixed `"remote"` path.
- `MCP-Servers/README.md:76-79` says remote bridges like UEMCP declare `setup.command` and the installer runs it. The current root manifest does not declare a UEMCP setup command.
- `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md:117-127` says the current root manifest declares a UEMCP setup clause; it does not.
- `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md:66-72` still shows `UNREAL_TCP_TIMEOUT_MS` default `5000`; current UEMCP manifest and server default are `10000`.
- `D:/DevTools/UEMCP/.mcp.json.example:10` still uses `UNREAL_TCP_TIMEOUT_MS = "5000"`.

Impact:

- Operators can believe the installer is release-pinned, setup-complete, and timeout-current when it is not.
- Stale docs hide the real UEMCP install contract.

Required fix:

- Update docs only after the installer behavior is corrected.
- Use staged claims: "configured", "plugin synced", "project deps verified", "server/plugin versions match", "runtime smoke passed".

### Finding 10 - Test coverage does not cover the installer risks

**Severity**: Medium

Evidence:

- Installer tests currently cover `buildValidationHeaders` and Perforce `P4_ENABLE_ADMIN` config wiring.
- There are no tests for JSON parse failure handling, doctor verdicts, remote source resolution, cache versioning, post-setup ordering, update mode, UEMCP post-setup, or Codex project config.
- Atlassian and Miro have no `npm test` script and no `*.test.mjs` files.
- CI bridge tests only run Perforce, Discord, and Otter.

Impact:

- The existing green test suite does not prove that the installer properly installs every bridge.
- UEMCP can drift without any failing CI signal.

Required fix:

- Add installer unit tests before changing behavior.
- Add fixture-backed UEMCP install/doctor tests that do not require Unreal Editor.
- Add Atlassian and Miro server discovery tests.

### Finding 11 - Remote bridge execution is trusted but not pinned

**Severity**: Medium

Evidence:

- Remote bridge code is downloaded from GitHub and may contain setup/post-setup scripts.
- The installer guards script names and extensions, but it does not verify a release signature, checksum, pinned tag, or commit before executing bridge scripts.
- UEMCP currently falls back to `HEAD` because latest release is missing.

Impact:

- This is acceptable for a private/trusted single-owner tool, but not safe to advertise as a general remote plugin marketplace.
- Support claims should explicitly say remote bridges are trusted-source installs until pinning exists.

Required fix:

- Cache and record commit SHA.
- Support pinned tags or commits in root manifest.
- Display the source identity before running remote setup/post-setup scripts.

## Verification performed

Commands run:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test

cd D:\DevTools\AI-Tools\MCP-Servers\lib
node --test

cd D:\DevTools\AI-Tools
git ls-files "Installers/MCP-Suite/Scripts/**/*.mjs" "MCP-Servers/**/*.mjs" | % { node --check $_ }

foreach ($b in @('atlassian','miro','perforce','discord','otter')) {
  cd D:\DevTools\AI-Tools\MCP-Servers\bridges\$b
  npm ci --dry-run
}

cd D:\DevTools\AI-Tools\MCP-Servers\bridges\perforce
npm test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\discord
npm test
cd D:\DevTools\AI-Tools\MCP-Servers\bridges\otter
npm test

cd D:\DevTools\UEMCP\server
npm test
node --check server.mjs
node --check sync-plugin-helper.mjs
node --check verify-deploy.mjs
```

Results:

- Installer tests: pass, 8 tests.
- Shared lib tests: pass, 9 tests.
- JS syntax check for installer and bridge `.mjs`: pass.
- Bridge `npm ci --dry-run`: pass for Atlassian, Miro, Perforce, Discord, Otter.
- Perforce tests: pass, 131 tests.
- Discord tests: pass, 12 tests.
- Otter tests: pass, 8 tests.
- UEMCP server rotation: pass, 2201 assertions, 4 env/live-gated skips.
- UEMCP `verify-deploy` for `.uemcp-targets.txt`: `ALL-SYNC` for the OperationPhoenix OnSight target.

Important limitation:

- These checks do not prove the central installer fully installs UEMCP. In fact, the live config inspection found a stale cached UEMCP server path and missing doctor coverage.

## Recommended implementation plan

### Phase 1 - Make doctor truthful

Implement an expanded `doctor` before changing install behavior.

Acceptance:

- It flags the current OperationPhoenix UEMCP mismatch: config version/server cache `1.0.4` vs deployed/local UEMCP `1.0.13`.
- It reports whether each configured server path exists.
- It reports whether Codex project config is present and whether it drifts from `.mcp.json`.
- It reports UEMCP deploy marker, target `.uproject` dependency state, and server/plugin version alignment.
- It exits non-zero on stale or partial installs.

### Phase 2 - Fix remote source identity and cache semantics

Acceptance:

- Root manifest can express `latest-release`, `head`, `tag`, or `commit` explicitly.
- If no latest GitHub release exists, HEAD fallback records the resolved SHA.
- Cache paths include tag or SHA, not just `"remote"`.
- Update mode rewrites `.mcp.json` server paths when the resolved source changes.
- Doctor detects versionless legacy caches and recommends update.

### Phase 3 - Make central UEMCP install complete or explicitly partial

Acceptance:

- The installer either runs UEMCP's full setup contract or performs equivalent steps itself.
- Target `.uproject` dependency state is checked and, if intended, repaired.
- `sync-plugin.bat` result, deploy marker, plugin descriptor version, and configured server version are all checked.
- If no build/relaunch is performed, the installer says "plugin synced, build/relaunch still required" instead of implying runtime-ready status.

### Phase 4 - Harden config writes

Acceptance:

- Parse failures abort install/update.
- Existing public and secret config are backed up before modification.
- Writes are atomic where practical.
- Tests cover malformed `.mcp.json`, malformed `.mcp.local.json`, and partial update recovery.

### Phase 5 - Simplify front-end responsibility

Acceptance:

- PowerShell wrapper handles workspace/project selection and Node availability only.
- Node installer owns selected-bridge dependency install.
- Node version is enforced against `minNodeVersion`.
- UEMCP gets explicit `.uproject` selection when multiple projects are detected.

### Phase 6 - Add Codex project support after installer truth is fixed

Acceptance:

- `.codex/config.toml` is generated from final `.mcp.json` state.
- Doctor compares Claude and Codex project entries.
- Existing global Codex MCP duplicates are reported.
- No Codex support claim is added before discovery smoke.

### Phase 7 - Repair docs and support claims

Acceptance:

- README no longer says "one fetch per release" unless release-pinned cache exists.
- UEMCP manifest spec matches the actual root manifest and UEMCP manifest.
- Timeout defaults are consistent across UEMCP manifest, server default, `.mcp.json.example`, and generated configs.
- Claims are staged by evidence: config written, plugin synced, dependencies verified, versions aligned, runtime smoke passed.

## Recommended next task

Start with Phase 1. Add doctor tests and implement expanded doctor state reporting. That gives us a safe way to prove every later installer fix, and it immediately catches the real UEMCP drift already present in OperationPhoenix.
