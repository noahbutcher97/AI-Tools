# Windows completion watcher setup

The completion watcher collects job exit reports in a private local database. Its Windows installer can be run from the desktop or an existing administrative SSH login for the same desktop user. Initial installation leaves provider delivery disabled and installs an empty grant policy. The existing relay CLI and MCP registrations continue to use their configured locations.

## Prepare and review

Use the checked-out package builder with the installed Node runtime and absolute paths to the two native provider executables. Choose a new directory outside the checkout. Each desktop builds its own package.

```text
node watcher-package.mjs build <new-directory> <codex-executable> <claude-executable>
node watcher-package.mjs verify <directory> <package-digest>
```

The builder copies the fixed broker and worker modules and the three runtimes, compiles the named-pipe helper, and creates an empty job database. The digest covers the member names and their exact bytes. Review the source revision and the provenance of the installed executables before approving a digest. A digest by itself establishes byte identity.

Run the plan in 64-bit Windows PowerShell. It verifies package hashes, checks for an existing installation, account or task collision, and constructs the two task definitions in memory. It makes no installation changes.

```text
Install-CompletionWatcher.ps1 -Mode Plan -Package <directory> -PackageDigest <reviewed-digest>
```

## Apply the approved watcher plan

Run the reviewed installer from a location controlled by the administrator, under the signed-in desktop user's elevated account. Pass the independently reviewed digest for this machine. Windows PowerShell must have the LocalAccounts module and Task Scheduler must support a local S4U batch logon.

```text
Install-CompletionWatcher.ps1 -Mode Apply -Package <directory> -PackageDigest <reviewed-digest>
```

Setup creates the non-administrative local account `RelayWatchBroker` with a random password. Windows requires that password when the installer registers an S4U task for a different account. Setup passes it in memory to Task Scheduler during registration. S4U stores no password for subsequent starts. [Windows Task Scheduler security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)

- `CrossAgentRelayCompletionBroker` runs under the broker account using S4U at the desktop user's logon. Setup starts it once and requires a current heartbeat from the PID reported by the scheduled task.
- `CrossAgentRelayCompletionWorker` is an on-demand, non-elevated task under the interactive desktop account. The broker may start it through the authenticated local channel.

If startup fails, check the broker account's Windows events. Security event 4625 with logon type 4 and status `0xC000015B` means Windows declined the batch logon. The account needs the **Log on as a batch job** right. After a successful logon, PowerShell event 4100 can identify an execution policy that prevented the installed permission check from running. A broker-only `RemoteSigned` policy permits that local script. An administrator can configure both settings for the designated broker account. Repeating Apply with the reviewed package verifies the running task and completes the installation record.

Administrators own the installed code and configuration under the system Program Files relay directory. The broker can write its job store, health projection and grant publications. The designated desktop account can read the health and grant directories. Initial authority is empty. Enabling provider dispatch and adding grants require qualified provider startup and an independently protected owner policy. Doctor reports `reports_only` when this initial installation is healthy.

A retry with the same package uses the private installation record and verifies registered task identities and actions. If an interrupted installation has an assigned broker account but no broker task, setup needs a fresh credential for registration. After approving a password reset for that dedicated account, repeat Apply with `-RenewBrokerPassword`. Setup checks the installation tag and account SID before resetting the password. Existing registered tasks reuse their S4U registration. Setup preserves existing owner policy, live job data and unrelated entries. An initialized but missing job database stops installation. A different distribution digest needs a reviewed upgrade procedure.

## Deactivate and retain state

```text
Install-CompletionWatcher.ps1 -Mode Rollback
```

Rollback stops and removes the two managed tasks and disables the dedicated account. The package, account SID, grant policy and job database remain available for recovery. Apply with the original digest and `-RenewBrokerPassword` can reactivate the installation.

This installer is the watcher component of fleet setup. Mesh enrollment, SSH credentials, inbound receive policy and provider MCP registration are separate machine-setup operations. The watcher plan grants no authority to change them.
