# MCP Bridges (AI-Tools)

Central installer + curated MCP bridges for Claude Code and Cowork.

## What this is

A small installer (`installer/install.bat`) that lets you opt in to one or
more MCP "bridges" for any project workspace on your machine. Each bridge is
a self-contained Node script that exposes external services (Perforce, Jira,
Miro, Unreal Engine) as MCP tools that Claude can call.

The installer handles:

- Downloading the chosen bridges (cached locally; one fetch per release)
- Walking you through credential acquisition (browser-assisted where possible)
- Validating credentials immediately
- Writing or merging `.mcp.json` (public config) and `.mcp.local.json` (secrets)
  in the workspace folder

## Quick start (Windows)

1. Download the installer bundle (one zip from the latest GitHub release)
2. Unzip anywhere
3. Double-click `install.bat`
4. Pick your workspace folder, choose which bridges to enable, paste tokens
   when prompted

That's it. The bridges become available the next time you run `claude` from
that workspace folder.

## Available bridges

| Bridge | What it does |
|---|---|
| `perforce` | p4 commands as MCP tools (list opened files, sync, describe, etc.) |
| `atlassian` | Jira + Confluence operations |
| `miro` | Miro whiteboard boards + items |
| `uemcp` | Unreal Engine editor automation (UE 5.x) |

## Repo layout

```
manifest.json                    # catalog of available bridges
installer/                       # the central installer
  install.bat / install.ps1
  install.mjs                    # orchestration
  _lib/                          # installer-only helpers
_shared/                         # runtime helpers used by bridge servers
  resolve-config.mjs             # 3-tier .mcp.json / env var resolution
  bridge-base.mjs                # standardized bridge config loader
bridges/
  perforce/
    manifest.json                # bridge metadata (fields, validation, etc.)
    server.mjs                   # the bridge runtime
    package.json
    credentials/                 # bridge-specific credential flows
  atlassian/
  miro/
docs/                            # additional documentation
```

## Adding a new bridge

1. Create `bridges/<name>/` with `manifest.json`, `server.mjs`, `package.json`
2. Add an entry to root `manifest.json` under `bridges`
3. Push. Users running the installer will see it in the menu.

For "remote" bridges (separate repo with their own setup script — like UEMCP),
declare `source.type = "remote-repo"` with the repo path and optional
`setup.command`. The installer downloads, runs the bridge's own setup, and
moves on.

## Security

- Public, non-secret config goes in `.mcp.json` (safe to commit, but typically
  ignored anyway because it carries machine-specific paths)
- Secrets (API tokens, passwords) go in `.mcp.local.json` — installer
  automatically adds this filename to `.gitignore` and `.p4ignore.local`
- Bridges read both files via 3-tier resolution at startup: env vars >
  `PROJECT_ROOT` env > nearest `.mcp.json` walking up from the current dir
- No tokens leave your machine; the installer never uploads anything

## Updating

The installer checks GitHub for newer releases at most once per 24 hours.
When found, it prompts before swapping caches — never auto-updates without
your consent. Force a check with `install.bat --update`.

Optional: `install.bat --enable-update-checks` writes a Claude Code SessionStart
hook that prints a one-line notice when a newer release is available.
