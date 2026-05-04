# UEMCP Manifest Spec

To make UEMCP installable through the AI-Tools central installer, drop a
`manifest.json` at the root of your UEMCP repo (the same level as `setup.bat`).

The central installer downloads the latest UEMCP release from
`github.com/noahbutcher97/UEMCP`, then reads this manifest to know how to
deploy it. UEMCP keeps its own setup logic (your `setup.bat`); the central
installer just orchestrates.

## File path in UEMCP repo

```
UEMCP/
├── manifest.json              <-- ADD THIS
├── setup.bat                  (existing)
├── server/
│   └── server.mjs
└── ...
```

## manifest.json contents

```jsonc
{
  "schemaVersion": "1.0",
  "name": "uemcp",
  "displayName": "Unreal Engine MCP (UEMCP)",
  "description": "Unreal editor automation. Requires UE editor running.",
  "version": "1.0.0",
  "main": "server/server.mjs",
  "fields": [
    {
      "name": "UNREAL_PROJECT_ROOT",
      "label": "Unreal project root (folder containing .uproject)",
      "type": "string",
      "secret": false,
      "required": true,
      "examplePlaceholder": "D:/UnrealProjects/5.6/MyProject"
    },
    {
      "name": "UNREAL_PROJECT_NAME",
      "label": "Unreal project name (no extension)",
      "type": "string",
      "secret": false,
      "required": true,
      "examplePlaceholder": "MyProject"
    },
    {
      "name": "UNREAL_TCP_PORT_EXISTING",
      "label": "TCP port for existing UEMCP plugin",
      "type": "string",
      "secret": false,
      "required": false,
      "default": "55557"
    },
    {
      "name": "UNREAL_TCP_PORT_CUSTOM",
      "label": "TCP port for custom UEMCP plugin",
      "type": "string",
      "secret": false,
      "required": false,
      "default": "55558"
    },
    {
      "name": "UNREAL_TCP_TIMEOUT_MS",
      "label": "TCP timeout (ms)",
      "type": "string",
      "secret": false,
      "required": false,
      "default": "5000"
    },
    {
      "name": "UNREAL_RC_PORT",
      "label": "Remote Control port",
      "type": "string",
      "secret": false,
      "required": false,
      "default": "30010"
    },
    {
      "name": "UNREAL_AUTO_DETECT",
      "label": "Auto-detect UE plugin presence",
      "type": "string",
      "secret": false,
      "required": false,
      "default": "true"
    }
  ],
  "autoDetect": {
    "type": "uproject"
  }
}
```

## What this enables

When users run the AI-Tools `install.bat`, they'll see UEMCP in the bridge
selection menu. If they enable it:

1. Installer downloads the latest UEMCP release from your repo (cached locally).
2. Installer **runs your `setup.bat`** with `--workspace <path>`. Your existing
   setup logic (downloading the UE plugin, running editor scripts, etc.)
   continues to work.
3. Installer reads the `fields` in the manifest to know what `.mcp.json`
   entry to add for UEMCP. The user is prompted for any required field that
   `autoDetect: { type: "uproject" }` doesn't already fill.

## Optional: manifest-driven setup (skip your setup.bat)

If the bulk of your `setup.bat` work isn't needed for every workspace
(e.g., the UE plugin is already installed once globally), you can omit the
`setup.command` clause and the central installer will treat UEMCP like any
other co-located bridge — just gather credentials per `fields`, write
`.mcp.json`, done.

The current AI-Tools root `manifest.json` declares UEMCP with a `setup`
clause:

```jsonc
"uemcp": {
  "source": { "type": "remote-repo", "repo": "noahbutcher97/UEMCP", "release": "latest", "subPath": "." },
  "setup": { "command": "setup.bat", "args": ["--workspace", "{WORKSPACE}"], "platform": "win32" }
}
```

Remove the `setup` block in AI-Tools' root manifest if/when you'd rather have
the central installer drive everything from the UEMCP `manifest.json`'s
`fields` declaration.

## Post-setup hook — auto-deploy the UE plugin

Add a `postSetup` block so the central installer automatically runs
`sync-plugin.bat` (which xcopies `plugin/UEMCP/` into the user's UE project's
`Plugins/` folder, excluding `Binaries/Intermediate/`):

```jsonc
"postSetup": {
  "command": "sync-plugin.bat",
  "args": ["{UNREAL_PROJECT_ROOT}/{UNREAL_PROJECT_NAME}.uproject", "--yes"],
  "platform": "win32",
  "description": "Copying UEMCP plugin into project's Plugins/ folder..."
}
```

The central installer:
1. Gathers the manifest fields (auto-detects `.uproject` → fills
   `UNREAL_PROJECT_ROOT` and `UNREAL_PROJECT_NAME`)
2. Validates (no validate block in your manifest → trivially OK)
3. Saves the bridge config to workspace `.mcp.json`
4. Runs the `postSetup.command` with `args` after placeholder interpolation
5. If the script exits 0 → `OK: Post-setup completed.`
6. If non-zero → warning, but the bridge config remains saved

`{UNREAL_PROJECT_ROOT}` and `{UNREAL_PROJECT_NAME}` are interpolated from the
fields gathered earlier. `{WORKSPACE}` is also available if you need it.

**Security guards on `postSetup`** (handled by the installer, no work for you):
- `command` must be a plain filename (no path separators, no `..`)
- Extension must be in the allowlist: `.bat`, `.cmd`, `.ps1`, `.sh`, `.mjs`, `.js`
- Path is anchored to the bridge's cache dir via `safeJoin`
- Launcher is chosen by extension (cmd.exe `/c` for .bat, etc.)
- `shell: false` always; args passed as array (no shell injection surface)

The `--yes` flag in the args tells `sync-plugin.bat` to suppress its overwrite
prompt for unattended use.

## Validation (optional)

You can declare a `validate` block in the UEMCP manifest so the installer can
sanity-check the connection right after setup:

```jsonc
"validate": {
  "type": "command",
  "command": "node",
  "args": ["{UNREAL_PROJECT_ROOT}/Plugins/UEMCP/scripts/check-port.mjs", "{UNREAL_TCP_PORT_EXISTING}"],
  "expectExitCode": 0,
  "errorHints": {
    "ECONNREFUSED": "UE editor is not running, or the UEMCP plugin isn't loaded yet."
  }
}
```

This is optional. Skip it if you don't have a quick health-check script.

## Action items for you (or your UEMCP agent)

1. Create `manifest.json` at the root of the UEMCP repo with the contents above.
2. (Optional) Tag a release on the UEMCP repo so the central installer can
   download a stable version (`release: latest` follows the latest tag; falls
   back to `HEAD` of default branch if no releases exist yet).
3. (Optional) Update UEMCP's existing `setup.bat` to accept `--workspace PATH`
   if it doesn't already — the central installer passes this flag.

That's it. Once `manifest.json` is on the UEMCP repo, UEMCP becomes a
first-class option in the AI-Tools central installer.
