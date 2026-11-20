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

## Request one grant at broker startup

A broker build supporting policy version 2 can publish one job grant at startup under its existing service account. An administrator writes the private policy atomically and restarts the broker. Set `grants` to one Codex entry with `id`, `provider` set to `codex`, and `scope` set to `thread-status`. Set `startupRun.id` to the same raw ID and `startupRun.expiresAt` to the approved UTC deadline in ISO format with milliseconds. The top-level fields are `v` (2), `grants`, and `startupRun`. Provider dispatch still follows the independent worker setting.

After acquiring its exclusive listener the broker issues one capability through the existing private handoff. Repeating the same request across restarts recovers the same capability and consumed state. An incompatible earlier batch for this instance causes startup to fail. The receiver rechecks the current policy and deadline on claim, completion and dispatch. An empty version 1 policy revokes authority. Existing version 1 grants keep their explicit provisioning behavior.

## Qualify installed Codex completion

`Test-InstalledCodexWatcher.ps1` exercises the installed broker with a temporary delivery window. Use an administrator-controlled copy beside the reviewed installer. Each stage takes the same fresh `-TrialId` and reviewed `-ExpectedPackage`. Start with empty grants, an idle interactive worker, and disabled delivery.

1. Run `-Stage Start -SessionScript <absolute-path-to-Qualify-CodexCompletion.mjs>`. A non-elevated interactive task starts a disposable read-only Codex thread at low effort. Its private trial directory contains `session/target.json`. Confirm the exact raw ID, requested model and unique addressable thread in the disposable workspace.
2. Run `-Stage Run -Target <confirmed-raw-id>`. The broker reads a version 2 startup request, issues one grant with a four-minute expiry and releases the ordinary CLI runner. Older installations can use the version 1 provisioning task by explicitly passing `-RotateBrokerPassword` with approval to rotate the dedicated password. Success requires one matching job with exit code 23 and the broker's transcript-proven delivered state.
3. The supervisor restores empty policy and reports-only mode on success or ordinary failure. The runner archives its thread. Verify a fresh heartbeat and successful session-task exit before `-Stage Cleanup` removes the remaining trial artifacts. If the host shut down during the delivery window, restore the protected empty policy and disabled worker setting, restart the broker and verify its mode before cleanup. The job store retains its delivery record.

## Review and apply a broker-only update

Stage the current broker module against the previously reviewed package in a new private directory. Staging checks the previous digest and copies the other members byte for byte. Keep both packages until the update and its recovery window are complete.

For a change to the broker's job store module, use `stage-jobs` and pass `-Component Jobs` to the updater. Each update still replaces one reviewed file. Install a job store API addition before installing a broker that calls it.

```text
node watcher-package.mjs stage-broker <new-directory> <previous-directory> <previous-digest>
Update-CompletionBroker.ps1 -Operation Plan -PreviousPackage <previous-directory> -PreviousDigest <previous-digest> -NextPackage <new-directory> -NextDigest <new-digest>
```

Run the updater beside the reviewed installer from an administrator-controlled directory. Plan checks both manifests, the installed code, task definitions and policy. After approving the new digest, run the same command with `-Operation Apply`. Apply takes the installation lock, checks for empty grants and disabled delivery, swaps the broker module atomically, restarts the scheduled task and verifies its heartbeat before recording the new digest. A startup failure restores the reviewed previous module. A retry reconciles an interrupted journal write. The existing job database, task principals, credentials and provider binaries are preserved.

## File observation upgrade

Task Scheduler records a numeric result when the broker exits before its heartbeat. Codes 20–22 identify invocation, the protected ACL check and its timeout, respectively. Code 23 covers storage initialization or a standalone worker check. Codes 24–27 identify listener startup, policy loading, grant provisioning and an occupied listener, respectively.

For an installation with schedule support, stage the file watcher with `watcher-package.mjs stage-files <new-directory> <previous-directory> <previous-digest>`. Run the same updater with `-Component Files` for Plan and Apply. It verifies the compiled metadata helper and its source along with the changed broker modules. The broker needs attribute access to the explicitly granted resource. File grants live in private configuration. The updater leaves filesystem permissions on watched resources alone.

## Branch observation upgrade

If the installed package already includes branch observation, read the installed package digest from the setup journal and locate the matching base package. From the installer directory run `node watcher-package.mjs stage-branch-update <new-directory> <base-directory> <base-digest>` with absolute directories. A wrong base digest stops staging before it creates the output directory. Check the journal and retry with the matching package. Verify the printed digest with `node watcher-package.mjs verify <new-directory> <new-digest>`.

Use the protected updater with `-Component BranchUpdate -Operation Plan`, passing `-PreviousPackage`, `-PreviousDigest`, `-NextPackage` and `-NextDigest` from staging. Use the same arguments with `-Operation Apply` after checking the plan. The updater requires disabled delivery, an idle worker and an empty grant policy. It preserves the job database and permits changes to the branch observer, schedule watcher and completion broker. Check the journal digest and reports-only heartbeat after restart. Keep the base package for recovery if the heartbeat check fails.

For anonymous branch watching, stage a file-capable package with `stage-branches` and update it with `-Component Branches`. A protected `completion-git.json` selects the installed Git edition and pins the Git and HTTPS transport SHA-256 hashes. Use an administrator-controlled copy of `Test-InstalledBranchRead.ps1` beside the reviewed setup and trial scripts to check an expected public ref from the installed broker. The script removes its temporary profile and grant and restores reports-only operation.

To qualify the Windows credential reader on an existing branch-capable installation, first stage and apply the branch module refresh described above. Use that package and its digest as the base for `stage-acl`, then plan and apply the second verified package with `-Component Acl`. Use the final installed digest for the trial.

Run a protected copy of `Test-InstalledCredentialIsolation.ps1 -ExpectedPackage <digest>` alongside the matching installer and Codex watcher trial script. The existing reports-only broker must return the expected digests for two fresh machine-sealed random values. The second value goes through the repository reader in a separate trial directory with a fixed synthetic repository binding. The ordinary desktop must receive access denied on read and write opens of both files. Success removes the temporary task, records and receipts. Machine-scoped encryption relies on the file ACL to isolate accounts. The trial performs no Git request and requires no repository credential.

If a terminated trial or failed cleanup leaves artifacts, recover from an elevated shell using the matching protected scripts. Acquire the exclusive watcher install lock and verify the installed package, principals, empty policy, disabled delivery and fresh reports-only heartbeat. Inspect the administrator-owned `branch-credential-trial` directory. Its `trial.json` records the package, temporary task name and exact ciphertext member before task registration. Match these to the installed journal and the task description, desktop principal, interactive least-privilege logon, protected script action and `-DesktopRead` arguments. Stop and remove only that matching task if it exists.

Inspect the directory and file ACLs and reject reparse points before removal. The expected trial files are `challenge.bin`, the recorded member under the trial's own `branch-credentials` directory and `trial.json`. The two trial receipts are `branch-challenge.sha256` and `branch-reader.sha256` in the watcher health directory. Preserve the trial record alongside any unexpected entry or mismatched task so the next operator can identify the interrupted run. Keep an unverifiable record for inspection. Once the inventory matches, remove only the identified files, removing the trial record last, then remove the empty directories nonrecursively. Release the lock and confirm that the task and trial artifacts are absent before retrying. The production credential directory has a different parent.

### Private branch trial

Use a disposable repository with synthetic commits and a separate writer. After the installed credential isolation check passes, issue a short-lived read-only credential for that repository. The issuer's permissions establish its read-only scope. A successful Git read establishes access to the branch.

From the protected installation tools, run `Test-InstalledBranchRead.ps1` with the package digest, Git pins, canonical repository URL, exact ref and independently checked revision. Add `-ReaderUser <reader-login>`. Cancel if the repository or ref shown in the masked desktop prompt differs from the approved target. The check requires empty policy, disabled delivery and an unused credential directory. It creates a temporary version 6 grant and seals the reader's password to this machine and resource. The trial removes the record and restores reports-only mode after checking one baseline. Revoke the disposable credential at its issuer after the live checks.

If the private check is interrupted, revoke its credential at the issuer. Using the same protected script, run `Test-InstalledBranchRead.ps1 -PackageHash <installed-digest> -RecoverTrial <trial-id>`. Setup prints the ID before publishing any encrypted credential or grant. It also appears in the administrator-owned trial directory's recovery record. Recovery checks the installed package, policy, flag, profile and file inventory under the install lock before restoring reports-only mode. Preserve the record for inspection if another grant, a changed profile or an unrelated credential prevents recovery.

## Deactivate and retain state

```text
Install-CompletionWatcher.ps1 -Mode Rollback
```

Rollback stops and removes the two managed tasks and disables the dedicated account. The package, account SID, grant policy and job database remain available for recovery. Apply with the original digest and `-RenewBrokerPassword` can reactivate the installation.

This installer is the watcher component of fleet setup. Mesh enrollment, SSH credentials, inbound receive policy and provider MCP registration are separate machine-setup operations. The watcher plan grants no authority to change them.
