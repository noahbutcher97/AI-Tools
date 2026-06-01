# Repository Guidelines

## Project Structure & Module Organization

This repository is a Windows-oriented AI tooling suite. `MCP-Servers/` contains the bridge catalog, shared runtime helpers, and bridge implementations. Update `MCP-Servers/manifest.json` when adding or removing bridges. Put bridge code in `MCP-Servers/bridges/<name>/`, with its own `manifest.json`, `server.mjs`, `package.json`, and lockfile. Shared bridge utilities live in `MCP-Servers/lib/`; installer-only helpers live in `Installers/MCP-Suite/Scripts/lib/`. `Installers/MCP-Suite/` contains double-clickable installer and updater entrypoints. `Tools/Flatten-UEProject/` holds standalone PowerShell/batch utilities. `_handoffs/` is for durable audit or incident notes, named `YYYY-MM-DD-short-dash-name.md`.

## Build, Test, and Development Commands

- `Installers\MCP-Suite\Install-MCP-Suite.bat`: launch the guided installer.
- `Installers\MCP-Suite\Update-MCP-Suite.bat`: refresh already-enabled workspace bridges.
- `node Installers/MCP-Suite/Scripts/install.mjs --doctor --workspace=D:/path/to/workspace`: run a read-only workspace health check.
- `cd MCP-Servers/bridges/perforce; npm test`: run the current unit test suite.
- `git ls-files "MCP-Servers/**/*.mjs" | % { node --check $_ }`: syntax-check tracked bridge JavaScript from PowerShell.
- `cd MCP-Servers/bridges/<bridge>; npm ci --dry-run`: verify package and lockfile consistency.

## Coding Style & Naming Conventions

Use Node 18+ ESM (`.mjs`) for bridge and installer JavaScript. Keep JavaScript indentation at two spaces and PowerShell indentation at four spaces. Prefer clear camelCase function names, bridge IDs matching their folder names, and lower-case dash-separated handoff filenames. Keep comments brief and focused on non-obvious behavior or operational constraints.

## Testing Guidelines

Tests use Node's built-in `node:test` and should sit beside the code they cover as `*.test.mjs`. Add focused tests for parser logic, config resolution, manifest behavior, and any regression-prone bridge output handling. Before submitting bridge changes, run the relevant bridge tests, `node --check` on tracked `.mjs` files, and `npm ci --dry-run` for any package you changed.

## Commit & Pull Request Guidelines

Recent history uses short, scoped commits such as `installer: add Update-MCP-Suite.bat` or `perforce: add guarded p4_reconcile mutation tool`. Follow `area: imperative summary`, and keep areas aligned with folders or bridges. PRs should include the user-facing change, affected paths, verification commands with results, and any workspace or credential assumptions. Include screenshots only for installer UI changes.

## Security & Configuration Tips

Do not commit secrets. Public MCP config belongs in `.mcp.json`; tokens and passwords belong in `.mcp.local.json`. Installer changes must preserve existing workspace config instead of overwriting it, especially `.mcp.json` and `.mcp.local.json`.
