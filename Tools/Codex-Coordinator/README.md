# Codex Coordinator

Codex Coordinator is a Windows-oriented local coordination runtime for registered Codex peers and
first-party observation sensors. The reusable implementation lives in this directory. Workspace
bindings, volatile runtime state, and legacy rollback material remain separate.

## Runtime contract

- Node.js 18.18.0 or newer and PowerShell 7.4 or newer.
- One authoritative event journal and one future supervisor owner.
- Workspace-contained, network-disabled policy by default.
- Monitoring evidence never grants mutation, proof, build, editor, Perforce, or submit authority.
- Persistence failure must fail closed before any new durable mutation or model turn.

The checked-in example is configuration only. It contains no credentials, bearer tokens, thread
IDs, active monitors, or generated runtime state. Runtime data belongs below the configured local
AppData root and must not be committed.

## Development

```powershell
Set-Location D:/DevTools/AI-Tools/Tools/Codex-Coordinator
npm install
npm test
```

Tests use Node's built-in test runner and live beside the modules they cover.
