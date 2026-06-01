# AI-Tools

AI-Tools is a Windows-oriented tooling suite for local MCP bridge setup. It contains a central MCP Suite installer, a curated bridge catalog, and bridge runtimes for services such as Perforce, Atlassian, Miro, Discord, Otter.ai, and Unreal Engine.

The current installer writes workspace MCP config. The primary supported path today is a project workspace with `.mcp.json` for public config and `.mcp.local.json` for secrets.

## Current Status

- No packaged release zip is currently published. Use the source-checkout path below.
- Codex project-scoped config generation is planned, but the installer does not write `.codex/config.toml` yet.
- UEMCP central onboarding is partial. For reliable first-time UEMCP setup, use the UEMCP repo's own `setup-uemcp.bat` until central parity is implemented.
- The installer targets workspace config. It does not write global Claude Desktop config.

## Quick Start: Source Checkout

From PowerShell:

```powershell
git clone https://github.com/noahbutcher97/AI-Tools.git
cd AI-Tools
.\Installers\MCP-Suite\Install-MCP-Suite.bat
```

During setup:

1. Choose the workspace folder where your MCP client will be launched.
2. Select the bridges to enable.
3. Paste credentials or tokens when prompted.
4. Let the installer validate credentials where validation is available.
5. Restart the MCP client from that workspace.

Use `Installers\MCP-Suite\Update-MCP-Suite.bat` only for workspaces that already have bridges configured.

## Before You Start

- Node.js 18 or newer is required. The launcher checks that Node is available, but version enforcement is still a follow-up installer improvement.
- Perforce requires the `p4` CLI, a valid server/client/user, and either a current ticket or a password saved through the installer.
- Atlassian, Miro, Discord, and Otter.ai require service-specific API tokens and permissions.
- UEMCP requires an Unreal `.uproject`, plugin deployment, Unreal build/restart steps, and a running editor for live tools. Use standalone UEMCP setup for now if you are doing first-time UEMCP onboarding.

## What The Installer Writes

For the selected workspace, the installer writes or updates:

- `.mcp.json`: public MCP server entries, bridge metadata, public environment values, and local bridge server paths.
- `.mcp.local.json`: secret bridge values such as API tokens and passwords.
- `.mcp.json.bak.<timestamp>` and `.mcp.local.json.bak.<timestamp>` when existing files are changed.
- `.gitignore` or `.p4ignore.local` entries for `.mcp.local.json` where those ignore files are relevant.

The installer preserves existing workspace config for other bridges where possible. It does not currently generate Codex project config and does not modify global client config.

## Known Limitations

- No release zip is published yet.
- The doctor command checks workspace config parse health, bridge launch paths, required fields, version drift, and UEMCP project/deploy state. It is not a live MCP client discovery or end-to-end tool-availability test.
- UEMCP central install is incomplete for reliable first-time setup.
- Codex project config generation is not implemented yet.
- Interactive bridge selection can disable a previously enabled bridge if it is not selected again. Non-interactive runs preserve omitted bridges.

## Where To Go Next

- [MCP Suite installer details](Installers/MCP-Suite/README.md)
- [Bridge catalog and development notes](MCP-Servers/README.md)
- [Project-scoped MCP audit](./_handoffs/2026-05-31-codex-project-scoped-mcp-audit.md)
- [Installer broad audit](./_handoffs/2026-05-31-mcp-suite-installer-broad-audit.md)
- [First-contact onboarding design](./_handoffs/2026-05-31-mcp-suite-first-contact-onboarding-design.md)
