# MCP Bridge Catalog

This directory contains the bridge catalog, shared runtime helpers, and local stdio bridge implementations used by the AI-Tools installer.

For first-time setup, start at the repo root [README](../README.md). This file is a bridge catalog and developer reference.

## Support Boundary

The bridges in this directory are local stdio MCP servers. They are launched by an MCP client through workspace config written by the installer.

These docs do not claim hosted remote MCP support unless a specific bridge says so. The UEMCP catalog entry points at the UEMCP repo, but central first-time UEMCP setup is still incomplete; use standalone UEMCP onboarding for reliable Unreal setup.

## Available Bridges

| Bridge | Source | What it does |
|---|---|---|
| `perforce` | `bridges/perforce` | Perforce version-control operations such as info, opened files, changes, sync, diff, reconcile, and guarded write tools. |
| `atlassian` | `bridges/atlassian` | Jira issue and Confluence page operations. |
| `miro` | `bridges/miro` | Miro whiteboard board and item operations. |
| `discord` | `bridges/discord` | Discord guild, channel, thread, and message operations through a bot token. |
| `otter` | `bridges/otter` | Otter.ai Enterprise Public API workspace, channel, conversation, transcript, and audio-link operations. |
| `uemcp` | remote repo entry | Unreal Engine editor automation. Central installer parity is not complete for first-time setup. |

`otter` uses Otter.ai's Enterprise Public API and requires API-key access in the Otter workspace. Otter's hosted OAuth MCP endpoint is a separate option for clients that support remote MCP directly; this repository's bridge is the local stdio, installer-managed option.

## Directory Layout

```text
MCP-Servers/
  manifest.json                  # catalog of available bridges
  lib/                           # shared runtime helpers
    resolve-config.mjs           # env and workspace config resolution
    bridge-base.mjs              # standardized bridge config loader
  bridges/
    perforce/
      manifest.json              # bridge metadata, fields, validation
      server.mjs                 # bridge runtime
      package.json
      package-lock.json
      README.md                  # bridge-specific notes
    atlassian/
    miro/
    discord/
    otter/
  docs/                          # design and reference docs
```

The installer lives outside this directory at `Installers/MCP-Suite/`.

## Configuration Model

The installer writes workspace config:

- `.mcp.json` contains public MCP server entries, bridge metadata, public environment values, and local bridge server paths.
- `.mcp.local.json` contains secrets such as API tokens and passwords.
- Existing config is backed up before being rewritten.
- `.mcp.local.json` is added to `.gitignore` or `.p4ignore.local` where applicable.

Bridge runtimes resolve config from environment variables first, then workspace config rooted by `PROJECT_ROOT`, then nearby `.mcp.json` files where the shared resolver supports upward search.

## Adding Or Updating A Bridge

For a co-located bridge:

1. Create `bridges/<name>/`.
2. Add `manifest.json`, `server.mjs`, `package.json`, and `package-lock.json`.
3. Add focused `*.test.mjs` coverage beside the code when parser, config, manifest, or bridge-output behavior changes.
4. Add or update the bridge entry in `MCP-Servers/manifest.json`.
5. Update bridge-specific docs when credentials, permissions, or tool behavior changes.

For a remote-repo bridge, keep the central catalog entry conservative until the remote repo has a verified manifest and setup flow. Do not claim installer-driven first-time setup until the central installer can prove it.

## Development Checks

Useful checks from the repo root:

```powershell
git ls-files "MCP-Servers/**/*.mjs" | % { node --check $_ }
```

Run bridge tests from the bridge folder:

```powershell
cd MCP-Servers\bridges\perforce
npm test
```

Verify package and lockfile consistency for a changed bridge:

```powershell
cd MCP-Servers\bridges\perforce
npm ci --dry-run
```

Run installer health checks without modifying a workspace:

```powershell
node Installers\MCP-Suite\Scripts\install.mjs --doctor --workspace=D:\Projects\ExampleWorkspace
```

## Security

- Do not commit secrets.
- Public, non-secret config belongs in `.mcp.json`.
- Tokens and passwords belong in `.mcp.local.json`.
- Bridge docs should describe required permissions narrowly.
- Avoid broad support claims for clients, hosted transports, or first-time setup paths that are not verified by this repository.
