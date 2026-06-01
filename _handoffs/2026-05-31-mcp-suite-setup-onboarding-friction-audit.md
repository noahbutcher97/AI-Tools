# Handoff: MCP Suite setup and onboarding friction audit

**Date**: 2026-05-31
**Scope**: first-time setup journey for `AI-Tools` MCP Suite, installer entrypoints, setup docs, bridge prerequisites, current OperationPhoenix wiring, and local `D:/DevTools/UEMCP`
**Status**: Audit complete, implementation plan proposed
**Mode**: Read-only audit. No installer, bridge, or UEMCP runtime code changed.

## Executive summary

The onboarding problem is not one prompt or one missing check. It is that a new user does not get a reliable path from "I have heard there is an installer" to "the right bridge is usable in the right client." The first-contact docs are misplaced, the release/download path is currently false, setup steps are split across AI-Tools and UEMCP with different contracts, and completion does not produce a receipt that says what changed and what remains.

The most important fix is a guided setup contract with truthful checkpoints:

1. How do I obtain the installer?
2. What prerequisites will it install or verify?
3. Which workspace/client/project am I configuring?
4. Which credentials or local tools do I need before continuing?
5. What was written/copied/changed?
6. What must be restarted, built, synced, or verified next?

Until those checkpoints exist, adding more bridge features or more client config will make onboarding more fragile.

## Findings

### Finding 1 - First-contact docs point to a release that does not exist

**Severity**: High

Evidence:

- The repository root currently has no `README.md`.
- `Installers/MCP-Suite/` has no README.
- The discoverable quick start is under `MCP-Servers/README.md`, not at the GitHub landing page.
- `MCP-Servers/README.md:20-29` tells users to download "one zip from the latest GitHub release" and double-click `Install-MCP-Suite.bat`.
- Live GitHub API checks on 2026-05-31 returned `404 Not Found` for both:
  - `https://api.github.com/repos/noahbutcher97/AI-Tools/releases/latest`
  - `https://api.github.com/repos/noahbutcher97/UEMCP/releases/latest`
- The repos themselves are public and active, so the 404 is a missing release, not a missing repo.

Impact:

- A new user following the documented first step is blocked before the installer starts.
- GitHub's repo landing page will not show the quick start because the quick start is not in a root README.
- The installer is documented as a packaged artifact but currently behaves like a source-checkout tool.

Required fix:

- Add a root `README.md` with a two-path quick start:
  - "Packaged release" only once releases exist.
  - "Source checkout" path that works today.
- Add `Installers/MCP-Suite/README.md` for users who land directly in the installer folder.
- Either create real GitHub releases with installer zip assets, or remove release-zip claims until that distribution path exists.

### Finding 2 - Setup docs describe a simpler world than the installer actually supports

**Severity**: High

Evidence:

- `MCP-Servers/README.md:12-18` says the installer downloads bridges, walks credentials, validates credentials, and writes/merges config.
- `MCP-Servers/README.md:28-29` says bridges become available the next time the user runs `claude` from that workspace.
- `MCP-Servers/README.md:76-79` says remote bridges like UEMCP declare a setup command and the installer runs it.
- `MCP-Servers/manifest.json:34-47` declares UEMCP as a `remote-repo` with `fallback`, but no `setup.command`.
- `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md:117-127` says the current root manifest has a UEMCP setup block; it does not.
- `Installers/MCP-Suite/Scripts/install.mjs:1247-1257` treats post-setup failures as warnings and still says config was saved.

Impact:

- Users can believe setup is complete when only config was written or only plugin files were copied.
- The docs hide the difference between "configured for Claude", "configured for Codex", "UEMCP plugin copied", "UEMCP plugin compiled", and "live editor reachable".

Required fix:

- Stage support claims by evidence level:
  - installer starts
  - config written
  - credentials validated
  - server path exists
  - project/client config visible
  - UEMCP plugin copied
  - UEMCP project dependencies verified
  - editor/build/restart complete
  - live smoke passed
- Rewrite the UEMCP manifest spec to match the actual manifest and current central installer behavior.

### Finding 3 - Workspace, client, and project selection are conflated

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/install.ps1:92-152` asks only for a "workspace folder for this install."
- Central UEMCP auto-detection at `Installers/MCP-Suite/Scripts/install.mjs:505-529` shallow-scans for the first `.uproject` and returns it.
- UEMCP's own `setup-uemcp.bat:176-190` asks separately for the Claude workspace folder and the exact `.uproject` file.
- UEMCP's own `setup-uemcp.bat:247-252` prints the resolved UEMCP repo, project, project dir, workspace root, and layout before proceeding.
- Current OperationPhoenix has both `.mcp.json` and `.codex/config.toml`, but Codex support is not generated or verified by the central installer.

Impact:

- Users do not know whether to choose repo root, project root, wrapper workspace, `.uproject` parent, or client working directory.
- A multi-project workspace can silently bind UEMCP to the wrong `.uproject`.
- Codex users can run from the right folder and still attach to stale/global MCP config.

Required fix:

- Make setup explicitly choose:
  - target workspace root
  - target client(s): Claude, Codex, or both
  - target Unreal `.uproject` when UEMCP is selected
- Show a pre-write preview:
  - workspace root
  - client config files to write
  - bridge server path
  - project root / `.uproject`
  - secret file path

### Finding 4 - Prerequisite checks are incomplete and uneven

**Severity**: Medium

Evidence:

- `MCP-Servers/manifest.json:7` declares `minNodeVersion: "18.0.0"`.
- `Installers/MCP-Suite/Scripts/install.ps1:50-86` checks that `node` exists, but not its version.
- `Installers/MCP-Suite/Scripts/install.ps1:186-199` may run `npm ci` for all co-located bridges before the user selects bridges.
- Perforce validation runs `p4 info` through the bridge manifest, but top-level setup docs do not tell a first-time user that Perforce CLI and a workspace/ticket may be needed.
- UEMCP's own setup script gives more explicit Node/PATH guidance at `D:/DevTools/UEMCP/setup-uemcp.bat:45-86`.

Impact:

- Users can hit late failures that should have been preflighted up front.
- A user selecting one bridge may see dependency setup for unrelated bridges.
- Different bridge paths teach different prerequisite expectations.

Required fix:

- Add a setup preflight screen before bridge selection:
  - Node found and version
  - npm found
  - git/winget availability if needed
  - per-bridge required external tools when that bridge is selected
  - client config target availability
- Move all selected-bridge dependency installation into the Node installer after selection.

### Finding 5 - Credential onboarding lacks a preflight checklist

**Severity**: Medium

Evidence:

- Atlassian, Miro, Discord, and Otter manifests contain inline token instructions and `openUrl` fields.
- Perforce setup fields are in `MCP-Servers/bridges/perforce/manifest.json:9-74`, but there is no first-run checklist explaining `p4 login`, `P4CLIENT`, `P4DEPOT`, or when `P4PASSWD` is optional.
- Discord and Otter have README setup sections; Atlassian and Miro do not.
- `Installers/MCP-Suite/Scripts/install.mjs:620-680` prompts field-by-field only after the bridge is selected.

Impact:

- Users discover missing accounts/tokens/tooling in the middle of setup.
- A failed credential attempt may leave users unsure whether the problem is token, permissions, site name, CLI availability, or client restart.

Required fix:

- Add a pre-setup "what you need" screen after bridge selection and before mutation:
  - Perforce: server, username, client, depot path, existing `p4 login` or password.
  - Atlassian: site name, account email, API token.
  - Miro: team/app token and required scopes.
  - Discord: bot token, bot installed into target server, optional guild allowlist.
  - Otter: Enterprise Public API access and API key.
  - UEMCP: `.uproject`, UE editor closed for copy/build-sensitive work, expected client restart.
- Keep bridge-specific README setup sections consistent across all bridges.

### Finding 6 - Onboarding has no dry-run or receipt

**Severity**: Medium

Evidence:

- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:102-122` writes `.mcp.json` and `.mcp.local.json`, backing up existing files when a backup tag is provided.
- `Installers/MCP-Suite/Scripts/install.mjs:1261-1268` writes config and prints only `Done. Run 'install.bat --doctor' to verify.`
- The installer can also update ignore files through `ensureSecretIgnored`.
- UEMCP post-setup can copy plugin files into the target project.
- UEMCP standalone setup can edit `.uproject` plugin dependencies at `D:/DevTools/UEMCP/setup-uemcp.bat:407-452`.

Impact:

- Users do not get a durable record of what changed.
- Support cannot inspect a single non-secret receipt to understand a failed install.
- Users have no dry-run view before config and project files are changed.

Required fix:

- Add `--preview` / dry-run mode for install/update.
- Write a non-secret receipt after real runs:
  - selected bridges
  - config files written
  - backups created
  - client targets written
  - bridge source identity
  - server paths
  - post-setup actions
  - manual next steps
  - doctor verdict

### Finding 7 - Completion guidance is too generic for first-time success

**Severity**: Medium

Evidence:

- `MCP-Servers/README.md:28-29` says run `claude` from the workspace.
- `Installers/MCP-Suite/Scripts/install.mjs:1268` says `Run 'install.bat --doctor' to verify`, but the actual entrypoint is `Install-MCP-Suite.bat`.
- `D:/DevTools/UEMCP/setup-uemcp.bat:454-464` gives stronger next steps: close Claude, open Unreal Editor once, `cd` into workspace, start Claude, run `project_info`.
- The current central `doctor` at `Installers/MCP-Suite/Scripts/install.mjs:982-1001` does not verify server path, tool discovery, client config, UEMCP deployment, or restart needs.

Impact:

- First-time users can finish setup and still not know whether to restart the MCP client, rebuild the UE plugin, run `claude`, use Codex, or run a bridge sanity tool.
- The named verification command is stale.

Required fix:

- Make completion bridge-specific:
  - Perforce: run `p4_bridge_status` / `p4_info`.
  - Atlassian/Miro/Discord/Otter: run `connection_info` or equivalent if present.
  - UEMCP: open UE once, restart client, run `project_info` or `connection_info`.
- Print client-specific restart instructions for Claude and Codex.
- Replace stale `install.bat` references.

### Finding 8 - UEMCP central setup is a partial onboarding path

**Severity**: High

Evidence:

- `D:/DevTools/UEMCP/README.md:9-20` documents a complete standalone UEMCP onboarding path.
- `D:/DevTools/UEMCP/setup-uemcp.bat:407-452` edits required `.uproject` dependencies.
- `D:/DevTools/UEMCP/manifest.json:93-98` only declares `sync-plugin.bat` as `postSetup`.
- `D:/DevTools/UEMCP/sync-plugin.bat:1-35` documents itself as a plugin source sync tool, not full new-machine setup.
- `D:/DevTools/UEMCP/sync-plugin.bat:326-346` prints build/cache guidance, but it does not write `.mcp.json` or `.uproject` dependencies.
- Current OperationPhoenix `.mcp.json` still points at cached UEMCP `1.0.4` and timeout `5000`, while local UEMCP is `1.0.13`.

Impact:

- Central installer onboarding for UEMCP can leave users with a copied plugin but stale server config or missing project dependency state.
- Users cannot infer whether they should run AI-Tools central install, UEMCP standalone setup, or both.

Required fix:

- Pick one supported UEMCP onboarding path:
  - central installer owns full UEMCP setup, or
  - central installer delegates to UEMCP setup and records that result, or
  - central installer marks UEMCP as partial/manual until parity exists.
- Do not list UEMCP as normal one-click central onboarding until this is resolved.

### Finding 9 - Update onboarding is not a recovery story

**Severity**: Medium

Evidence:

- `Update-MCP-Suite.bat:5-7` says update mode reads `.mcp.json`, discovers bridges, and reruns with saved credentials.
- `Installers/MCP-Suite/Scripts/install.ps1:207-277` discovers bridges only from `.mcp.json` and forces `--non-interactive`.
- Current OperationPhoenix has `.codex/config.toml` with UEMCP entries, but the update flow does not treat Codex project config as a source or verification target.
- Current `doctor` exits `0` while reporting UEMCP as enabled in OperationPhoenix.

Impact:

- Users can run update after a bad setup and still keep stale or mismatched client/project state.
- Update gives no "you are fixed now" evidence.

Required fix:

- Make update end with the same receipt and doctor report as install.
- Include Codex/Claude project config comparison.
- For UEMCP, compare remote cache, configured server version, deployed marker, and local/upstream source identity.

## Read-only probes performed

```powershell
git remote -v

Invoke-RestMethod https://api.github.com/repos/noahbutcher97/AI-Tools/releases/latest
Invoke-RestMethod https://api.github.com/repos/noahbutcher97/UEMCP/releases/latest

node Installers\MCP-Suite\Scripts\install.mjs --help

node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\UnrealProjects\5.6\OperationPhoenix

rg -n "uemcp|P4_ENABLE_ADMIN|UNREAL_TCP_TIMEOUT_MS|args|command|version" D:\UnrealProjects\5.6\OperationPhoenix\.mcp.json
rg -n "uemcp|P4_ENABLE_ADMIN|UNREAL_TCP_TIMEOUT_MS|args|command|version" D:\UnrealProjects\5.6\OperationPhoenix\.codex\config.toml
```

Results:

- `origin` is `https://github.com/noahbutcher97/AI-Tools.git`.
- AI-Tools latest release API returned `404 Not Found`.
- UEMCP latest release API returned `404 Not Found`.
- `node install.mjs --help` succeeded, but examples use Unix-style line continuations.
- OperationPhoenix doctor exited `0` and reported UEMCP `enabled`.
- OperationPhoenix `.mcp.json` still points UEMCP at the cached `remote/server/server.mjs`, records UEMCP `version = "1.0.4"`, and uses `UNREAL_TCP_TIMEOUT_MS = "5000"`.
- OperationPhoenix `.codex/config.toml` also points UEMCP at the cached remote server and uses timeout `5000`.

## Recommended implementation plan

### Phase O-1 - Fix first-contact onboarding

Acceptance:

- Root `README.md` exists and gives the current true setup path.
- `Installers/MCP-Suite/README.md` exists and explains exactly what double-clicking each `.bat` does.
- Release-zip instructions are removed until a real GitHub release asset exists, or a release asset is published and verified.
- Quick start includes a "what you need before you start" checklist.

### Phase O-2 - Add a setup preflight and preview

Acceptance:

- Installer preflight checks Node version, npm, selected bridge external tools, and client target availability.
- Installer shows a pre-write preview of workspace, client config files, selected bridges, server paths, and UEMCP project target.
- Preview mode can run without writing.

### Phase O-3 - Add result accounting, receipt, and doctor recovery

Acceptance:

- Installer records per-bridge result states.
- Explicitly requested skipped/failed bridges produce non-zero exit.
- A non-secret receipt is written after every install/update.
- Doctor reads current state and prints actionable recovery steps.

### Phase O-4 - Resolve UEMCP onboarding ownership

Acceptance:

- The central installer either fully matches UEMCP standalone setup or clearly delegates to it.
- UEMCP setup has a single documented source of truth.
- UEMCP central setup verifies `.uproject` dependency state, plugin deploy marker, server version, and client restart/build needs.

### Phase O-5 - Make client support explicit

Acceptance:

- Setup asks whether to configure Claude, Codex, or both.
- Claude support writes and verifies `.mcp.json` / `.mcp.local.json`.
- Codex support writes and verifies `.codex/config.toml`.
- No docs claim Codex support for a bridge until discovery smoke has passed.

## Recommended next task

Implement Phase O-1 first, even before code changes. It removes the current first-step dead end: the repo needs a root quick start and installer-local README that describe what works today, not a release package or UEMCP setup contract that does not exist yet.
