# MCP Suite Installer

This folder contains the Windows launcher scripts and the Node installer for AI-Tools MCP bridges.

## Which File Do I Run?

- `Install-MCP-Suite.bat`: guided setup for a workspace.
- `Update-MCP-Suite.bat`: refresh bridges already enabled in an existing workspace.
- `Scripts/install.mjs`: CLI and automation entrypoint for advanced use.

Use the batch files for normal double-click or PowerShell usage. Use `Scripts/install.mjs` when you need `--doctor`, `--bridges`, `--non-interactive`, or field overrides.

## Choosing A Workspace

Choose the folder where the MCP client will be launched and where workspace MCP config should live. The installer writes `.mcp.json` and `.mcp.local.json` into that folder.

For Unreal projects with wrapper folders, this may be the wrapper workspace rather than the folder containing the `.uproject`. UEMCP has a separate Unreal project path requirement, and the central installer does not handle that first-time setup reliably yet. For UEMCP onboarding, use the UEMCP repo's `setup-uemcp.bat` until central parity is implemented.

## What Happens During Install

The guided installer:

1. Checks that Node.js is available.
2. Asks for the target workspace folder.
3. Loads the bridge catalog from `MCP-Servers/manifest.json`.
4. Installs bundled bridge package dependencies.
5. Lets you select bridges.
6. Prompts for public values and secrets.
7. Validates credentials where a bridge declares validation.
8. Writes `.mcp.json` and `.mcp.local.json`, with backups for existing files.
9. Adds `.mcp.local.json` to `.gitignore` or `.p4ignore.local` when those ignore files are relevant.
10. Runs bridge post-setup hooks when the bridge manifest declares one.

After the script finishes, restart your MCP client from the configured workspace.

## After Install

Run a read-only doctor check from the AI-Tools checkout:

```powershell
node .\Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\Projects\ExampleWorkspace
```

The doctor output is useful for confirming that the workspace config has bridge entries, but it is not a full tool-availability test yet. For service bridges, use the bridge's normal sanity tools from your MCP client after restart.
It now checks config parse health, bridge launch paths, required fields, version drift, and UEMCP project/deploy state.

## CLI Examples

Run these commands from `Installers\MCP-Suite`.

Read-only workspace check:

```powershell
node .\Scripts\install.mjs --doctor --workspace=D:\Projects\ExampleWorkspace
```

Non-interactive Perforce setup with public fields only:

```powershell
node .\Scripts\install.mjs --workspace=D:\Projects\ExampleWorkspace --bridges=perforce --non-interactive --field=P4PORT=ssl:perforce.example.com:1666 --field=P4USER=example-user --field=P4CLIENT=example_Project --field=P4DEPOT=Project/Main
```

Force a cache/update pass for a configured workspace:

```powershell
node .\Scripts\install.mjs --update --workspace=D:\Projects\ExampleWorkspace
```

Avoid putting API tokens or passwords into shell history. Prefer the guided prompts for secret-bearing bridges unless automation is required.

## Known Limitations

- Result accounting now classifies unknown, skipped, failed, and partially configured bridge outcomes, and writes non-secret install receipts.
- Interactive bridge selection treats unchecked previously enabled bridges as disabled. Non-interactive runs preserve omitted bridges.
- UEMCP central onboarding is partial and should not be treated as reliable first-time Unreal setup.
- Codex project config is not generated.
- Doctor is a config/deploy health check, not a live MCP client discovery or end-to-end tool-availability test.
