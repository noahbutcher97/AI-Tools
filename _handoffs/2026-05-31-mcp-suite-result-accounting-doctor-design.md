# Handoff: MCP Suite result accounting and doctor design

**Date**: 2026-05-31
**Scope**: targeted design for the next runtime installer slice after first-contact docs
**Status**: Implemented in commit `1965686` (`installer: add result accounting doctor`)
**Mode**: Historical design plus implementation record. The original design pass was docs-only; the follow-up implementation is now committed.

## Implementation note

The result accounting, receipt writer, parse-safe config loader, expanded doctor, and UEMCP stale-build check were implemented after this design in commit `1965686`. Remaining out-of-scope items from this design still stand: Codex project config generation, remote cache-by-SHA semantics, full UEMCP setup parity, and live MCP client discovery.

## Goal

Make the installer tell the truth after install/update and make `--doctor` prove enough state to catch the real failures we have already seen.

This slice should produce two concrete outcomes:

1. Install/update returns structured per-bridge results instead of silently continuing and ending with a generic `Done`.
2. Doctor reports actionable workspace health, including config parse failures, missing server paths, required field gaps, stale bridge versions, and UEMCP project/deploy drift.

The slice should not try to solve every installer problem. In particular, it should not implement Codex config generation, remote cache-by-SHA semantics, full UEMCP setup parity, or live MCP client discovery. Those depend on this slice being reliable first.

## Current evidence

Code state:

- `Installers/MCP-Suite/Scripts/install.mjs:982-1001` has a shallow `runDoctor()` that only prints `.mcp.json` presence, layout, and per-bridge `enabled` / `absent` / `disabled`.
- `Installers/MCP-Suite/Scripts/install.mjs:1082-1259` loops selected bridges, but fetch, manifest, credential, validation, setup, and post-setup failures mostly `continue` without a run-level failure model.
- `Installers/MCP-Suite/Scripts/install.mjs:1247-1257` says post-setup failures are warnings and says config was saved before the actual write at line 1261.
- `Installers/MCP-Suite/Scripts/install.mjs:1268` still prints `Done. Run 'install.bat --doctor' to verify.`
- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs:13-34` collapses missing JSON and parse-failed JSON into `{}`, so install can later overwrite malformed-but-recoverable config.

Live read-only baseline on 2026-05-31:

- `node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\UnrealProjects\5.6\OperationPhoenix` exits 0 and reports UEMCP `enabled`.
- That same workspace `.mcp.json` launches UEMCP from `C:/Users/posne/AppData/Local/mcp-bridges/bridges/uemcp/remote/server/server.mjs`.
- The configured UEMCP bridge metadata records `version: "1.0.4"` and `UNREAL_TCP_TIMEOUT_MS: "5000"`.
- The cache manifest at `.../bridges/uemcp/remote/manifest.json` is UEMCP `1.0.4`.
- The deployed project marker at `OnSight/Plugins/UEMCP/.uemcp-deploy-marker.json` is `manifestVersion: "1.0.13"` and `upluginVersionName: "1.0.13"`.
- The target `OnSight.uproject` does not list `RemoteControl`, `PythonScriptPlugin`, or `GeometryScripting`.
- The deployed plugin descriptor `OnSight/Plugins/UEMCP/UEMCP.uplugin` is `VersionName: "1.0.13"`.
- Latest-release checks still return 404 for both `noahbutcher97/AI-Tools` and `noahbutcher97/UEMCP`; default branch HEADs were `AI-Tools main c6527f0b335e` and `UEMCP main f8e33a1897b8`.

The current doctor misses the exact stale-server/deployed-plugin mismatch that should be the first acceptance test for this slice.

## Alternatives considered

### Option A - Expand `runDoctor()` in place

This is the smallest patch: keep everything in `install.mjs`, add more checks, and adjust exit codes.

Tradeoff: it gives quick output, but it keeps the monolith growing and does not solve install/update completion truth. The installer could still end with `Done` after partial failure while doctor has a separate definition of health.

### Option B - Shared result and health primitives

This is the recommended approach. Create small pure modules for config loading status, bridge health checks, UEMCP-specific checks, install result accounting, and receipt writing. `runDoctor()` and `runInstall()` both use those primitives.

Tradeoff: slightly more upfront work, but it gives tests a clean target and prevents doctor/install from drifting.

### Option C - Full installer transaction rewrite

This would solve post-setup ordering, cache identity, UEMCP setup parity, receipts, preflight, preview, and Codex support in one large pass.

Tradeoff: too broad. It would mix state reporting with behavior changes and make it harder to verify which change fixed which failure.

## Recommended scope

Implement Option B in a narrow runtime slice.

This slice should change reporting, failure classification, parse safety, receipts, and doctor checks. It should not change bridge setup semantics except where required to stop reporting success for failures.

Required behavior changes:

- Unknown bridge names in `--bridges=` should be usage errors, not silent skips.
- A selected bridge that cannot be fetched, loaded, validated, configured, or post-setuped should produce a per-bridge non-OK result.
- Install/update should return non-zero when any explicitly selected bridge ends as `failed` or `partial`.
- Malformed `.mcp.json` or `.mcp.local.json` should stop install/update before mutation and should be reported by doctor.
- Post-setup failure should be `partial`, not a hidden warning behind a successful run.
- Final output should print an actionable summary and the correct doctor command.

Required non-behavior changes:

- Doctor stays read-only.
- Doctor prints human-readable output by default and supports JSON output if the implementation cost stays low.
- Install/update writes a non-secret receipt after real runs. If the run aborts before mutation because config cannot be parsed, it may print the result without writing a workspace receipt.

## Proposed file boundaries

Keep `install.mjs` as the CLI orchestrator, but move testable logic into focused modules:

- `Installers/MCP-Suite/Scripts/lib/mcp-config.mjs`
  - Preserve current public API where practical.
  - Add parse-status fields so missing and malformed JSON are distinct.
  - Add a helper that throws or returns a fatal diagnostic when config is malformed before mutation.

- `Installers/MCP-Suite/Scripts/lib/install-results.mjs`
  - Defines result statuses, severities, summary rollup, exit-code mapping, and redaction helpers.
  - Does not read or write the filesystem.

- `Installers/MCP-Suite/Scripts/lib/doctor.mjs`
  - Runs read-only workspace health checks and returns a structured report.
  - Contains generic bridge checks: config presence, launch entry, server path, manifest version, public/secret required fields, dependency markers where practical.
  - Owns the human-readable and JSON formatting for doctor output.

- `Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs`
  - Contains UEMCP-specific read-only checks: configured project path, `.uproject`, required project plugin dependencies, deployed plugin descriptor, deploy marker, configured server bundle version, timeout default drift, and editor-lock/build hints if cheap and read-only.

- `Installers/MCP-Suite/Scripts/lib/receipt.mjs`
  - Writes non-secret install/update receipts.
  - Keeps secrets redacted and stores only field names, not secret values.

This structure avoids turning `install.mjs` into a larger mixed-purpose file and lets tests cover the state classifiers directly.

## Result model

Every selected bridge should produce one result object:

```json
{
  "bridge": "uemcp",
  "requested": true,
  "previouslyEnabled": true,
  "status": "partial",
  "severity": "warning",
  "stages": {
    "source": { "status": "ok", "path": "..." },
    "manifest": { "status": "ok", "version": "1.0.4" },
    "credentials": { "status": "ok", "publicFields": ["UNREAL_PROJECT_ROOT"], "secretFields": [] },
    "validation": { "status": "skipped" },
    "config": { "status": "ok", "serverPath": "..." },
    "postSetup": { "status": "failed", "message": "exit 1" }
  },
  "actions": [
    "Run sync-plugin.bat manually after closing Unreal Editor."
  ]
}
```

Allowed top-level statuses:

- `ok`: requested work completed.
- `partial`: config or some setup work completed, but a required follow-up action remains because part of the selected bridge failed.
- `failed`: requested bridge was not configured or an existing config cannot be trusted.
- `skipped`: bridge was intentionally not configured and no mutation was attempted.
- `disabled`: previously enabled bridge was explicitly disabled.
- `absent`: bridge is not present in workspace config. Doctor-only.

Exit-code mapping:

- `0`: all explicitly requested install/update work is `ok`, `skipped` by explicit user choice before mutation, or no-op.
- `1`: at least one explicitly requested bridge is `partial` or doctor finds warning/error health issues.
- `2`: usage error or fatal pre-mutation condition, such as unknown `--bridges=` name or malformed existing config.
- `99`: unexpected unhandled installer error, preserving the current catch-all intent.

This makes non-interactive automation safer and gives the double-click user a visible partial/failure summary.

## Receipt design

Write receipts under the workspace:

```text
.mcp-install-receipts/
  2026-05-31T19-42-10-install.json
```

Receipt fields:

- `schemaVersion`
- `runId`
- `mode`: `install` or `update`
- `startedAt`, `endedAt`
- `aiToolsRoot`
- `workspace`
- `selectedBridges`
- `exitCode`
- `summary`: counts by status and severity
- `files`: public config path, secret config path, backup paths, ignore files changed
- `bridgeResults`: non-secret result objects
- `doctorSummary`: optional result from running the same read-only health classifier after config writes
- `nextSteps`: human-actionable strings

Redaction rules:

- Never store secret values.
- For secret fields, store only `{ "name": "ATLASSIAN_API_TOKEN", "present": true }`.
- Store server paths, workspace paths, bridge versions, command names, and public environment field names/values because they are already in `.mcp.json`.
- Do not copy `.mcp.local.json` content into receipts.

## Doctor design

Doctor should produce a concise table plus detail blocks for non-OK items.

Generic checks:

- Workspace path exists.
- `.mcp.json` exists and parses.
- `.mcp.local.json` parses if present.
- Modern `bridges` layout and legacy `mcpServers` layout are both recognized.
- For each bridge in `MCP-Servers/manifest.json`:
  - absent / disabled / enabled state
  - `mcpServers.<name>.command` present when enabled
  - first server arg exists on disk when command is `node`
  - nearest bridge `manifest.json` can be found from server path
  - configured `bridges.<name>.version` matches located bridge manifest version
  - required public fields are present
  - required secret fields are present in `.mcp.local.json`
  - package dependency state is at least plausibly installed where a `package.json` declares dependencies

UEMCP checks:

- `UNREAL_PROJECT_ROOT` and `UNREAL_PROJECT_NAME` are present.
- `<root>/<name>.uproject` exists.
- `<project>/Plugins/UEMCP/UEMCP.uplugin` exists and parses.
- `<project>/Plugins/UEMCP/.uemcp-deploy-marker.json` exists and parses.
- Configured server bundle manifest version matches deployed marker `manifestVersion` and plugin `VersionName`.
- `UNREAL_TCP_TIMEOUT_MS` matches the configured bundle manifest default unless explicitly documented as an override.
- Target `.uproject` lists the required project dependencies expected by UEMCP standalone setup: `RemoteControl`, `PythonScriptPlugin`, and `GeometryScripting`.
- If the UEMCP DLL is missing, report `needs-build` or `needs-deploy` instead of generic failure.

Current OperationPhoenix expected result after this slice:

- Doctor exits `1`.
- UEMCP is not merely `enabled`; it reports at least:
  - `version-mismatch`: configured/cached server `1.0.4` vs deployed marker/plugin `1.0.13`.
  - `timeout-drift`: workspace config has `UNREAL_TCP_TIMEOUT_MS=5000` while current bundle defaults are `10000`.
  - `needs-project-deps`: target `.uproject` does not list `RemoteControl`, `PythonScriptPlugin`, or `GeometryScripting`.
- The report gives next steps without editing the workspace.

## Testing strategy

Use fixture-backed tests before changing behavior.

Recommended tests:

- `mcp-config.test.mjs`
  - malformed `.mcp.json` returns parse status and does not collapse to `{}` silently
  - malformed `.mcp.local.json` is reported separately
  - valid config preserves existing behavior

- `doctor.test.mjs`
  - missing `.mcp.json` returns exit `1` and action to run installer
  - malformed `.mcp.json` returns exit `2`
  - enabled bridge with missing server path reports `server-path-missing`
  - enabled bridge with required secret missing reports `missing-secret`
  - recorded version mismatch reports `version-mismatch`
  - disabled bridge does not require a server path

- `uemcp-doctor.test.mjs`
  - fixture with server manifest `1.0.4` and deploy marker/plugin `1.0.13` reports `version-mismatch`
  - fixture missing required `.uproject` plugin dependencies reports `needs-project-deps`
  - fixture with missing deploy marker reports `needs-sync`
  - fixture with missing DLL reports `needs-build`
  - fixture with timeout `5000` against default `10000` reports `timeout-drift`

- `install-results.test.mjs`
  - rollup returns exit `0` for all OK
  - rollup returns exit `1` for any partial/failed selected bridge
  - unknown non-interactive bridge name maps to exit `2`
  - receipt redaction keeps secret values out of serialized output

Verification commands:

```powershell
cd D:\DevTools\AI-Tools\Installers\MCP-Suite\Scripts
node --test

cd D:\DevTools\AI-Tools
git ls-files "Installers/MCP-Suite/Scripts/**/*.mjs" "MCP-Servers/**/*.mjs" | % { node --check $_ }

node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\UnrealProjects\5.6\OperationPhoenix
```

The OperationPhoenix doctor command is read-only and should become a proof case that the stale UEMCP state is now visible.

## Implementation sequence

1. Add fixture workspaces under `Installers/MCP-Suite/Scripts/test-fixtures/`.
2. Add parse-status tests in `mcp-config.test.mjs`.
3. Update `mcp-config.mjs` so missing JSON and malformed JSON are distinct.
4. Add `install-results.mjs` and tests for rollup, exit codes, and redaction.
5. Add `doctor.mjs` generic health checks with tests.
6. Add `uemcp-doctor.mjs` with fixture tests.
7. Wire `runDoctor()` to the new doctor module and preserve CLI behavior except for stronger exit codes.
8. Wire `runInstall()` to collect per-bridge results instead of `continue`-only flow.
9. Write non-secret receipts after install/update attempts that reach the mutation phase.
10. Replace the stale final `install.bat --doctor` message with the correct command.
11. Run the verification commands and capture the new OperationPhoenix doctor output.

## Non-goals for this slice

- No Codex config generation.
- No global Codex MCP cleanup.
- No live MCP client process restart or discovery smoke.
- No remote bridge cache identity rewrite by tag/SHA.
- No full UEMCP setup parity.
- No automatic `.uproject` mutation.
- No network checks in doctor by default.
- No secret values in logs, doctor JSON, or receipts.

## Acceptance checks

- Installer tests include the new config parse, result rollup, generic doctor, and UEMCP doctor cases.
- Doctor flags the current OperationPhoenix UEMCP stale state and exits non-zero.
- Doctor remains read-only; file timestamps for `.mcp.json`, `.mcp.local.json`, `.codex/config.toml`, and `.uproject` do not change during doctor.
- Running install/update with an explicitly selected bridge that fails validation or post-setup no longer ends as a generic success.
- Malformed existing `.mcp.json` or `.mcp.local.json` aborts install/update before any write.
- Receipts contain no API tokens, passwords, or `.mcp.local.json` secret values.
- The final installer message names the correct doctor command.

## Open design decisions

- Whether `skipped` after a user-selected interactive bridge should exit `0` or `1`. Recommendation: exit `0` only if the user skips before any mutation and the summary clearly says the selected bridge was not configured; exit `1` for validation/post-setup failures after the installer attempted the bridge.
- Whether doctor JSON should be added in this slice or deferred. Recommendation: add it if it falls naturally out of the structured report, but do not delay the human-readable doctor for JSON formatting.
- Whether package dependency checks should inspect `node_modules`, `.npm-deps-state.json`, or both. Recommendation: start with presence checks and warnings only; do not run `npm` from doctor.

## Recommended next step

Turn this design into an implementation plan with tests first. The first test should reproduce the current unsafe behavior: malformed config is not distinguishable from missing config. The second proof case should be the OperationPhoenix UEMCP mismatch, because that is the live failure doctor must stop missing.
