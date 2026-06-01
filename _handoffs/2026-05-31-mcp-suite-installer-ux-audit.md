# Handoff: MCP Suite installer UX audit

**Date**: 2026-05-31
**Scope**: `Installers/MCP-Suite/`, installer prompt helpers, bridge manifests, installer docs, and local `D:/DevTools/UEMCP` setup scripts
**Status**: Audit complete, implementation plan proposed
**Mode**: Read-only UX audit. No installer or bridge runtime code changed.

## Executive summary

The installer has useful UX foundations: double-click batch entrypoints, a folder picker fallback, arrow-key bridge selection, browser-assisted token pages, hidden secret prompts, immediate credential validation, and pause-before-exit in the PowerShell wrapper.

The weak point is user-state clarity. The installer can end with success language even when selected work was skipped, can ask users to disable previously enabled bridges during what looks like an enable/install flow, and does not produce a final summary that says what changed, what failed, what remains manual, and which client needs a restart. UEMCP is the sharpest example: its own setup script asks for an exact `.uproject` and prints concrete next steps, while the central installer auto-detects the first `.uproject`, exposes low-level environment fields, runs only `sync-plugin.bat`, and then reports generic post-setup success.

The UX fix should not start with visual polish. Start with a state model: selected, configured, skipped, failed, disabled, post-setup partial, needs restart, needs build, needs manual token, needs project dependency repair. Then print that model in the installer, updater, and doctor.

## UX findings

### Finding 1 - Successful exit can hide skipped or failed selected work

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:1035-1039` filters unknown `--bridges=` names and only prints `Skipping unknown`.
- Probe on 2026-05-31:

  ```powershell
  node Installers\MCP-Suite\Scripts\install.mjs --workspace=D:\DevTools\AI-Tools --bridges=not-a-bridge --non-interactive
  ```

  Output included `Skipping unknown: not-a-bridge`, then `No bridges selected. Existing config (if any) left as-is.`, and exited `0`.
- `Installers/MCP-Suite/Scripts/install.mjs:1090-1094` continues after a fetch failure.
- `Installers/MCP-Suite/Scripts/install.mjs:1120-1149` continues after manifest load failures.
- `Installers/MCP-Suite/Scripts/install.mjs:1190-1235` can abandon one bridge and continue.
- `Installers/MCP-Suite/Scripts/install.mjs:1268` always prints `Done. Run 'install.bat --doctor' to verify.` after the loop.
- `Installers/MCP-Suite/Scripts/install.ps1:284-288` prints `Installer finished successfully.` for any Node exit code `0`.

Impact:

- A user can think a bridge was installed when it was skipped.
- Automation can treat a no-op as success.
- Support cannot distinguish "all requested work applied" from "nothing changed".

Required fix:

- Track per-bridge result states: `configured`, `already-current`, `skipped-unknown`, `skipped-validation`, `fetch-failed`, `manifest-failed`, `post-setup-failed`, `disabled`.
- Exit non-zero when any explicitly requested bridge could not be configured.
- Print a final summary table before process exit.
- Replace generic `Done` with the summary verdict: `Completed`, `Completed with warnings`, or `Failed`.

### Finding 2 - Install flow can accidentally become a disable flow

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:1048-1053` uses a multi-select menu labelled `Select bridges to ENABLE for this workspace`.
- Previously enabled bridges are pre-checked at `Installers/MCP-Suite/Scripts/install.mjs:1027-1032`.
- Unchecking a previously enabled bridge prompts at `Installers/MCP-Suite/Scripts/install.mjs:1072-1076`: `Mark disabled? (config is preserved)`, defaulting to yes.

Impact:

- A user entering the installer to add one bridge can accidentally disable an existing bridge.
- The primary menu mixes "select things to configure now" with "manage enabled state".
- Defaulting the disable confirmation to yes is risky in a non-technical flow.

Required fix:

- Split mode semantics:
  - `Add/update bridges`: selected bridges are configured; unselected bridges are left alone.
  - `Manage enabled bridges`: explicit mode where disabling is expected.
- If keeping one flow, default disable confirmation to no and show the current enabled bridge list before the menu.
- Include disable actions in the final summary.

### Finding 3 - UEMCP central installer UX is weaker than UEMCP's own setup UX

**Severity**: High

Evidence:

- Central installer `.uproject` detection returns the first `.uproject` found in a shallow scan at `Installers/MCP-Suite/Scripts/install.mjs:505-529`.
- The UEMCP bridge manifest exposes low-level fields directly, including ports, metrics, auto-detect flags, Python exec, and relaunch hint fields in the cached manifest at `C:/Users/posne/AppData/Local/mcp-bridges/bridges/uemcp/remote/manifest.json:26-95`, and in local UEMCP `D:/DevTools/UEMCP/manifest.json:26-88`.
- The central installer prints only `Post-setup completed.` for UEMCP at `Installers/MCP-Suite/Scripts/install.mjs:1251-1255`.
- UEMCP's own `setup-uemcp.bat:176-190` uses GUI selection for both workspace folder and exact `.uproject`.
- UEMCP's own `setup-uemcp.bat:247-252` prints the resolved repo, project, project dir, workspace root, and layout.
- UEMCP's own `setup-uemcp.bat:407-452` updates required `.uproject` plugin dependencies.
- UEMCP's own `setup-uemcp.bat:454-464` prints concrete next steps: open Unreal Editor once, `cd` into workspace, restart Claude, run a sanity-check command.

Impact:

- Central install can target the wrong Unreal project in multi-project workspaces.
- Users are asked to reason about internal UEMCP knobs instead of project selection and readiness.
- Generic post-setup success hides build/relaunch/dependency work.

Required fix:

- Add a UEMCP-specific project picker when multiple or zero `.uproject` files are detected.
- Treat advanced UEMCP fields as an advanced settings block with defaults, not a required front-door path.
- Print UEMCP-specific completion state:
  - `.mcp.json` written
  - plugin copied or not copied
  - `.uproject` dependencies verified or repaired
  - editor/build/relaunch required
  - client restart required
- Either reuse UEMCP's setup contract or make central installer output match it.

### Finding 4 - Doctor is not a useful user recovery screen

**Severity**: High

Evidence:

- `Installers/MCP-Suite/Scripts/install.mjs:982-1001` reports only config presence, layout, and enabled/absent/disabled status.
- Probe on 2026-05-31 against `D:/DevTools/AI-Tools` reported only `No .mcp.json found. Run installer to set one up.` and exited `1`.
- Probe on 2026-05-31 against `D:/UnrealProjects/5.6/OperationPhoenix` reported UEMCP `enabled` and exited `0`, despite the broader audit finding stale UEMCP server cache versus deployed/local UEMCP.

Impact:

- Users get a green or shallow report instead of a recovery path.
- The updater and support workflow do not have a trustworthy screen to say what is wrong.

Required fix:

- Turn doctor into a UX-first recovery report, not only a config presence check.
- For each bridge, print `status`, `problem`, `fix`, and `safe next command`.
- Include client-specific state: Claude `.mcp.json`, Codex `.codex/config.toml`, global duplicates, and restart requirement.
- Add a machine-readable `--json` mode after the human report is reliable.

### Finding 5 - Update flow is opaque and can overpromise

**Severity**: Medium

Evidence:

- `Update-MCP-Suite.bat:5-7` says it reads `.mcp.json`, discovers enabled bridges, and reruns update with no prompts.
- `Installers/MCP-Suite/Scripts/install.ps1:207-263` discovers enabled bridges only from `.mcp.json`.
- `Installers/MCP-Suite/Scripts/install.ps1:274-277` forces update mode to `--non-interactive`.
- `Installers/MCP-Suite/Scripts/install.mjs:236-257` refreshes remote cache for update, but current remote cache semantics are not source-identity based.

Impact:

- Users can believe update refreshed the active project state when Codex project config, stale global MCP state, or UEMCP deployed plugin state were not checked.
- Update mode has no final "what changed" list.

Required fix:

- Make update print discovered bridges before it does work and summarize the final source identity and server path for each.
- Refuse or warn when no matching project-scoped client config exists for the target client.
- After update, run doctor automatically and show the same final verdict vocabulary.

### Finding 6 - First-run dependency work happens before bridge selection

**Severity**: Medium

Evidence:

- `Installers/MCP-Suite/Scripts/install.ps1:186-199` runs `npm ci` for every co-located bridge with `package.json` and missing `node_modules`, before the user chooses bridges.
- `Installers/MCP-Suite/Scripts/install.mjs:213-260` also installs dependencies for selected bridges through `ensureBridgeAvailable`.

Impact:

- A first-time user can see slow `[deps] Installing for ...` output for bridges they never intend to use.
- A dependency failure in an unselected bridge can make the installer feel broken before the actual task starts.
- Front-end and back-end responsibility is duplicated.

Required fix:

- Let Node installer own dependency installation after bridge selection.
- If global preflight remains, call it `Preparing installer dependencies` and make it bounded to installer-owned packages only.

### Finding 7 - Node version and shell guidance are weaker than the stated requirement

**Severity**: Medium

Evidence:

- `MCP-Servers/manifest.json:7` declares `minNodeVersion: "18.0.0"`.
- `Installers/MCP-Suite/Scripts/install.ps1:50-86` checks only whether `node` exists.
- Help output from `Installers/MCP-Suite/Scripts/install.mjs:133-159` uses Unix-style line continuations in examples, even though this is a Windows-oriented installer.
- `Installers/MCP-Suite/Scripts/install.mjs:181` and `Installers/MCP-Suite/Scripts/install.mjs:1268` refer to `install.bat`, but the actual entrypoint is `Install-MCP-Suite.bat`.

Impact:

- Users with old Node get later syntax/API failures instead of one clear prerequisite error.
- Windows users can paste an example command that does not work as written.
- Error recovery points at the wrong script name.

Required fix:

- Enforce `minNodeVersion` in PowerShell and Node entrypoints.
- Rewrite examples for PowerShell first, with cmd.exe examples only if needed.
- Replace `install.bat` references with `Install-MCP-Suite.bat`.

### Finding 8 - Prompt layer has useful mechanics but lacks guardrails for non-TTY and long text

**Severity**: Medium

Evidence:

- `Installers/MCP-Suite/Scripts/lib/prompts.mjs:42-53` falls back to normal readline for secrets when raw TTY is unavailable, which can echo secrets.
- `Installers/MCP-Suite/Scripts/lib/prompts.mjs:143-159` redraws menu lines directly and does not wrap/truncate long descriptions.
- Captured probe output on 2026-05-31 contained raw ANSI escape sequences from `printSection` because there is no color-disable/non-TTY mode.

Impact:

- Secret entry can be unsafe or surprising in redirected/non-TTY contexts.
- Long bridge descriptions can wrap poorly or make the arrow menu hard to scan.
- Logs are harder to read when ANSI escapes are captured.

Required fix:

- In non-TTY secret mode, refuse interactive secret entry unless a `--field` override or saved secret exists.
- Add `NO_COLOR` / non-TTY color suppression.
- Truncate or wrap multi-select descriptions to the terminal width.

### Finding 9 - Bridge credential screens are not consistently staged for non-technical users

**Severity**: Medium

Evidence:

- Atlassian, Miro, Discord, and Otter manifests include token instructions and `openUrl` links.
- `Installers/MCP-Suite/Scripts/install.mjs:636-642` asks whether to open the URL, but some manifest instructions say the browser "will open" rather than "can open".
- Perforce exposes `P4_ENABLE_ADMIN` in the normal credential flow at `MCP-Servers/bridges/perforce/manifest.json:63-74`.
- UEMCP exposes metrics and advanced execution flags in the normal credential flow.
- Miro success text at `MCP-Servers/bridges/miro/manifest.json:44` includes `{MIRO_ORG_NAME}` even though that field is optional.

Impact:

- Users see advanced or internal settings before they understand the basic install path.
- Some prompt text implies behavior the installer actually asks permission for.
- Optional blank fields can create awkward validation messages.

Required fix:

- Add manifest field categories such as `basic`, `advanced`, and `dangerous`.
- Show advanced fields only when the user chooses advanced setup, while preserving non-interactive overrides.
- Normalize wording around browser opening.
- Make success messages robust when optional fields are blank.

### Finding 10 - There is no durable install receipt

**Severity**: Medium

Evidence:

- Installer output is console-only.
- `Installers/MCP-Suite/Scripts/install.mjs:1268` prints only a one-line doctor suggestion after writing config.
- The broader audit found current workspace state can drift across `.mcp.json`, `.codex/config.toml`, remote cache, and deployed UEMCP plugin state.

Impact:

- A non-technical user cannot easily send support a useful install result.
- A later session cannot distinguish original installer output from manually changed state.

Required fix:

- Write a local receipt under the workspace, for example `.mcp-install-report.json` and/or `.mcp-install-report.md`.
- Include selected bridges, versions/source identities, server paths, config files touched, backups made, post-setup results, restart/build requirements, and doctor verdict.
- Do not include secrets.

## Read-only probes performed

```powershell
node Installers\MCP-Suite\Scripts\install.mjs --help

node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\DevTools\AI-Tools

node Installers\MCP-Suite\Scripts\install.mjs --workspace=D:\DevTools\AI-Tools --non-interactive

node Installers\MCP-Suite\Scripts\install.mjs --workspace=D:\DevTools\AI-Tools --bridges=not-a-bridge --non-interactive

node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\UnrealProjects\5.6\OperationPhoenix
```

Results:

- Help printed successfully, but includes Unix line continuation examples and stale `install.bat` references elsewhere in installer output.
- AI-Tools doctor exited `1` with only `No .mcp.json found. Run installer to set one up.`
- Non-interactive without `--bridges` exited `2` with available bridge names.
- Unknown-only `--bridges=not-a-bridge --non-interactive` exited `0` after doing nothing.
- OperationPhoenix doctor exited `0` and reported UEMCP `enabled`, not stale or partial.

## Recommended implementation plan

### Phase UX-1 - Add result accounting and final summary

Acceptance:

- Unknown explicitly requested bridges cause a non-zero exit.
- Any selected bridge that cannot be configured is listed as failed or skipped in a final table.
- PowerShell wrapper prints `completed`, `completed with warnings`, or `failed` based on structured exit codes.
- The final summary lists files touched and says whether a client restart is required.

### Phase UX-2 - Split add/update from disable management

Acceptance:

- Default install flow never disables existing bridges just because they are not selected.
- A separate manage/disable mode handles removal or disabling.
- If a disable prompt remains, its default is no.

### Phase UX-3 - Make UEMCP a guided project setup

Acceptance:

- Central installer can ask for or choose an exact `.uproject`.
- Multiple `.uproject` candidates are shown as explicit choices.
- UEMCP advanced fields are hidden by default.
- Completion output matches UEMCP's real setup contract: plugin copied, dependencies checked, build/relaunch needed, client restart needed.

### Phase UX-4 - Replace shallow doctor with recovery report

Acceptance:

- Doctor prints per-bridge verdicts with problem and next action.
- Doctor catches stale UEMCP cache, missing server path, missing client project config, and known partial install states.
- Update mode runs doctor at the end.

### Phase UX-5 - Repair prompt and docs polish

Acceptance:

- Help examples are PowerShell-valid.
- Stale `install.bat` references are replaced.
- Non-TTY secret prompting refuses unsafe echo unless values are passed non-interactively.
- ANSI colors are suppressed for non-TTY or `NO_COLOR`.
- Long menu descriptions do not make the bridge selector hard to scan.

### Phase UX-6 - Add install receipt

Acceptance:

- Installer writes a non-secret receipt after install/update.
- Receipt includes bridge result states, source identities, touched files, backup paths, post-setup outputs, and next steps.
- Doctor can point to the latest receipt when diagnosing drift.

## Recommended next task

Implement Phase UX-1 together with the broader audit's Phase 1 doctor work. Result accounting and truthful doctor output solve the biggest UX and correctness problem at the same time: users need to know what happened, what did not happen, and what to do next.
