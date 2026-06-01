# Handoff: MCP Suite first-contact onboarding design

**Date**: 2026-05-31
**Scope**: targeted design for the next work slice after the setup/onboarding audit
**Status**: Implemented on 2026-05-31
**Mode**: Docs-first design. No runtime installer changes in this slice.

## Current-state note

After this docs-first slice, commit `1965686` implemented expanded result accounting and doctor checks. References below to the doctor being shallow or planned are retained as historical design context for the earlier first-contact docs pass; the remaining unsupported areas are Codex project config generation, full UEMCP first-time setup parity, and live MCP client discovery.

## Goal

Remove the current first-step onboarding dead end and give a new user a truthful path from "I found the repo" to "I know which setup path to run, what it configures, and what is not supported yet."

This slice should not try to fix installer behavior, Codex config generation, UEMCP setup parity, doctor, cache identity, or result accounting. Those remain follow-up implementation slices. The point here is to make the existing state legible and stop promising a release/package/support contract that does not exist yet.

## Recommended approach

Use a docs-first correction slice with three files:

1. Create root `README.md`.
2. Create `Installers/MCP-Suite/README.md`.
3. Update `MCP-Servers/README.md` so it becomes a bridge catalog/developer reference, not the primary onboarding page.

I do not recommend creating a GitHub release as part of this slice. A release would turn this into packaging, versioning, checksums, cache semantics, and installer verification work. The audit found deeper installer truth problems, so publishing a release before those are addressed would make the onboarding story look more durable than it is.

Before writing the docs, re-check the current release state for `noahbutcher97/AI-Tools` and `noahbutcher97/UEMCP`. If a release appears before implementation, adjust the wording to describe exactly what exists instead of repeating the 2026-05-31 audit snapshot.

## Alternatives considered

### Option A - Docs-first truth pass

This is the recommended path. It is low-risk, fast, and directly fixes the current broken first step. It makes the current source-checkout flow explicit and removes release-zip claims until packaging is real.

Tradeoff: it does not make setup more automated. It only stops misleading users.

### Option B - Publish a release zip now

This would make the existing quick start technically true, but it would also freeze current installer issues into a public onboarding artifact. The installer still has stale UEMCP cache behavior, shallow doctor checks, partial UEMCP setup, and no Codex-native project config.

Tradeoff: attractive short-term, bad long-term if users trust the release as "complete."

### Option C - Implement installer fixes before touching docs

This would eventually produce a cleaner final story, but it leaves the current repo landing path broken while we work through larger implementation. It also delays a cheap high-value correction.

Tradeoff: better eventual product, worse immediate onboarding.

## Design: root README

Create `README.md` at repo root. It should be the only first-contact page a new user needs.

Required sections:

- **What This Repo Is**
  - Windows-oriented AI tooling suite.
  - Central MCP Suite installer plus curated local stdio bridges.
  - Current primary supported client path is Claude-style workspace `.mcp.json` / `.mcp.local.json`.

- **Current Status**
  - No packaged release zip is currently published.
  - Use the source-checkout path for now.
  - Codex project-scoped config is planned/audited but not implemented by the installer yet.
  - UEMCP central install is currently partial; for reliable UEMCP onboarding, use the UEMCP repo's own `setup-uemcp.bat` until central parity is implemented.

- **Quick Start: Source Checkout**
  - Clone or pull `AI-Tools`.
  - Run `Installers\MCP-Suite\Install-MCP-Suite.bat`.
  - Select the workspace folder where the MCP client will run.
  - Select bridges.
  - Paste credentials/tokens as prompted.
  - Restart the MCP client from that workspace.
  - Run `Installers\MCP-Suite\Update-MCP-Suite.bat` only for already-configured workspaces.

- **Before You Start**
  - Node.js 18+ is required; installer can offer winget install when missing, but version enforcement is still a follow-up.
  - Perforce requires a valid P4 CLI/workspace/ticket or password.
  - Atlassian/Miro/Discord/Otter require service tokens and permissions.
  - UEMCP requires an Unreal `.uproject`, plugin deploy/build/restart steps, and should use standalone setup for now.

- **What The Installer Writes**
  - `.mcp.json` public config.
  - `.mcp.local.json` secrets.
  - Ignore-file entries for `.mcp.local.json` where applicable.
  - No global Claude Desktop config.
  - No Codex project config yet.

- **Known Limitations**
  - No release zip yet.
  - Doctor is currently shallow.
  - UEMCP central install is partial.
  - Codex project config generation is not implemented yet.

- **Where To Go Next**
  - Link `Installers/MCP-Suite/README.md` for installer details.
  - Link `MCP-Servers/README.md` for bridge catalog/dev details.
  - Link recent handoff audits for deeper implementation context if appropriate.

Tone should be direct and operational. Avoid marketing language and avoid claiming support that has not been verified.

## Design: installer README

Create `Installers/MCP-Suite/README.md` for users already looking at the installer folder.

Required sections:

- **Which File Do I Run?**
  - `Install-MCP-Suite.bat`: guided setup for a workspace.
  - `Update-MCP-Suite.bat`: refresh bridges already enabled in an existing workspace.
  - `Scripts/install.mjs`: CLI/automation entrypoint for advanced users.

- **Choosing A Workspace**
  - Choose the folder where the client will be launched and where project config should live.
  - For wrapped Unreal projects, this may be the wrapper workspace, not necessarily the folder containing `.uproject`.
  - UEMCP needs a separate `.uproject` concept; central installer does not handle that well yet.

- **What Happens During Install**
  - Node/PATH check.
  - Bridge selection.
  - Credential prompts.
  - Credential validation.
  - Config writes and backups.
  - Secret ignore handling.
  - Any bridge post-setup hooks.

- **After Install**
  - Restart client.
  - Run from the configured workspace.
  - Use bridge-specific sanity tools where available.
  - Run doctor, with caveat that doctor is shallow until the planned doctor slice lands.

- **Known Limitations**
  - Unknown/skipped bridge result accounting is not fixed yet.
  - Existing bridge disable behavior is under audit.
  - UEMCP central onboarding is partial.
  - Codex project config is not generated.

- **CLI Examples**
  - Use PowerShell-valid multiline commands, not Unix backslash continuations.
  - Include one non-interactive example.
  - Avoid private project names or user email addresses.

## Design: MCP-Servers README

Update `MCP-Servers/README.md` so it is no longer the first-contact onboarding page.

Changes:

- At the top, point users to root `README.md` for setup.
- Remove or rewrite "download one zip from latest GitHub release."
- Remove "one fetch per release" unless/until release-pinned cache semantics exist.
- Remove or qualify "remote bridges like UEMCP declare setup.command and installer runs it." Current UEMCP root manifest does not declare setup.
- Keep bridge catalog, config/security explanation, and bridge development notes.
- Add a support-claim note: bridge docs describe current local stdio bridge behavior, not hosted remote MCP support unless explicitly stated.

## Explicit non-goals

- Do not change installer runtime behavior.
- Do not publish a GitHub release.
- Do not add Codex config generation.
- Do not change UEMCP setup scripts.
- Do not fix doctor.
- Do not add install receipts.
- Do not edit workspace `.mcp.json` or `.codex/config.toml`.
- Do not clean up `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md` in this slice. It is stale and should be treated as a later docs cleanup; first-contact docs should not link it as the current UEMCP setup path.

These are all important, but they belong to later slices with tests.

## Acceptance checks

Manual checks after implementation:

```powershell
Test-Path README.md
Test-Path Installers\MCP-Suite\README.md
```

Expected: both return `True`.

Search for stale first-contact claims:

```powershell
rg -n "one zip from the latest GitHub release|one fetch per release|install\.bat|runs your `setup\.bat`|declares UEMCP with a `setup`" README.md Installers\MCP-Suite\README.md MCP-Servers\README.md
```

Expected: no matches.

Search for unsupported support claims:

```powershell
rg -n "Codex support|Codex project config|fully installs UEMCP|one-click UEMCP|release zip" README.md Installers\MCP-Suite\README.md MCP-Servers\README.md
```

Expected: matches are allowed only when phrased as current limitations or future work.

Check that stale UEMCP setup-spec material is not presented as current onboarding:

```powershell
rg -n "UEMCP-MANIFEST-SPEC|setup\.command|setup-uemcp\.bat" README.md Installers\MCP-Suite\README.md MCP-Servers\README.md
```

Expected: no matches for `UEMCP-MANIFEST-SPEC` or `setup.command`. `setup-uemcp.bat` is allowed only when pointing users to the standalone UEMCP setup path while central parity is incomplete.

Check PowerShell examples:

```powershell
rg -n "\\\\$| --workspace=.* \\\\" README.md Installers\MCP-Suite\README.md MCP-Servers\README.md
```

Expected: no Unix-style trailing backslash line continuations.

No runtime verification is required for this slice because it is documentation-only. Do not run install/update scripts except `--help` or read-only `--doctor` if desired.

## Second-pass verification

Verification run on 2026-05-31 after this design pass:

- `https://api.github.com/repos/noahbutcher97/AI-Tools/releases/latest` returned 404.
- `https://api.github.com/repos/noahbutcher97/UEMCP/releases/latest` returned 404.
- `README.md` is absent.
- `Installers/MCP-Suite/README.md` is absent.
- `MCP-Servers/README.md` is present and still contains stale first-contact claims: line 14 says cached bridge downloads are "one fetch per release"; line 22 says to download one zip from the latest GitHub release; line 78 says remote bridges declare `setup.command`.
- `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md` is present and stale: line 98 mentions AI-Tools `install.bat`; lines 113-117 describe `setup.command` and claim the current AI-Tools root manifest declares UEMCP setup.
- Placeholder-marker scan on this handoff found no unfinished markers.
- Trailing whitespace scan on this handoff found no matches.

These are implementation targets for the docs slice, not design blockers.

## Implementation result

Implemented on 2026-05-31:

- Created `README.md` as the repo first-contact onboarding page.
- Created `Installers/MCP-Suite/README.md` for installer-specific usage.
- Rewrote `MCP-Servers/README.md` as a bridge catalog and developer reference.
- Left runtime installer behavior unchanged.
- Left `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md` unchanged for a later stale-doc cleanup slice.

## Implementation sequence

1. Re-check release state for AI-Tools and UEMCP so the docs do not bake in a stale release assumption.
2. Create root `README.md`.
3. Create `Installers/MCP-Suite/README.md`.
4. Update `MCP-Servers/README.md` to point at root README and remove stale setup claims.
5. Run the acceptance searches above.
6. Run a placeholder/whitespace scan on changed docs.
7. Summarize the exact support claims that remain.

## Follow-up slices

After this design is implemented, the next runtime slice should be result accounting plus expanded doctor. That is where the installer starts proving setup state instead of only documenting caveats.
