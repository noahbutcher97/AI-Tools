# Windows completion watcher setup

The completion watcher collects job exit reports in a private local database. Its Windows installer can be run from the desktop or an existing administrative SSH login for the same desktop user. Initial installation leaves provider delivery disabled and installs an empty grant policy. The existing relay CLI and MCP registrations continue to use their configured locations.

## Prepare and review

### Existing watcher state

The broker that uses job-store schema 4 authenticates restored job, grant handoff, watch and observation rows with a key in its private state directory. Stage compatible broker modules together. Before a cutover, stop accepting new work and reconcile outstanding effects and their original receipts. Opening an older store retains the old rows. Unsigned work cannot prove its original association with a grant or proof handle and stays inert. Check earlier receipts using their original authority. A newly issued condition or job ID covers future work.

A missing key on an upgraded store requires trusted recovery. An earlier broker binary cannot read schema 4. Replacing the database with an old snapshot can replay previously valid work; the row authentication mechanism does not detect a matching rollback of the database and its authenticated rows. Installed upgrade and recovery require a separate qualification with the deployed package.

For current health, run `relay doctor --json`. In `watcher.record.subscriptions`, a paused condition with reason `grant_changed` indicates that the current grant differs from the stored revision. `stored_state_unverified` means the broker could not authenticate the required state. A revoked grant disappears from the list. The `partial` flag can indicate retained work whose identity cannot be safely displayed, or additional subscriptions beyond the bounded list. The read-only MCP tool `relay_doctor` shows the last dated CLI record.

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

Inspect the directory and file ACLs and reject reparse points before removal. The expected trial files are `challenge.bin`, the recorded member under the trial's own `branch-credentials` directory and `trial.json`. The two trial receipts are `branch-challenge.sha256` and `branch-reader.sha256` in the watcher health directory. Preserve unexpected entries and unverifiable records for inspection. Once the inventory matches, remove only the identified trial artifacts and empty credential directory. To remove the final directory, move its verified `trial.json` to `branch-credential-trial.cleanup.json` in the protected installation root using a move that refuses to overwrite an existing file.

An interrupted final cleanup can leave that sibling record with an empty trial directory or with the directory already gone. Under the same install lock, use the sibling as the recovery record and verify its contents and ACL, the installation identity, task absence and the remaining inventory. If both records exist, a task or directory is unexpected, or identity cannot be verified, preserve the evidence for inspection. Remove the verified empty trial directory nonrecursively, then delete the verified sibling record. Confirm that the trial artifacts are absent before releasing the lock and retrying. Older installations can retain the original `trial.json` inside the trial directory. The production credential directory has a different parent.

### Private branch trial

Use a disposable repository with synthetic commits and a separate writer. After the installed credential isolation check passes, issue a short-lived read-only credential for that repository. The issuer's permissions establish its read-only scope. A successful Git read establishes access to the branch.

From the protected installation tools, run `Test-InstalledBranchRead.ps1` with the package digest, Git pins, canonical repository URL, exact ref and independently checked revision. Add `-ReaderUser <reader-login>`. Cancel if the repository or ref shown in the masked desktop prompt differs from the approved target. The check requires empty policy, disabled delivery and an unused credential directory. It creates a temporary version 6 grant and seals the reader's password to this machine and resource. The trial removes the record and restores reports-only mode after checking one baseline. Revoke the disposable credential at its issuer after the live checks.

If the private check is interrupted, revoke its credential at the issuer. Using the same protected script, run `Test-InstalledBranchRead.ps1 -PackageHash <installed-digest> -RecoverTrial <trial-id>`. Setup prints the ID before publishing any encrypted credential or grant. It also appears in the administrator-owned trial directory's recovery record. Recovery checks the installed package, policy, flag, profile and file inventory under the install lock before restoring reports-only mode. Preserve the record for inspection if another grant, a changed profile or an unrelated credential prevents recovery.

Private trials publish the sealed record and Git profile by renaming completed files. Recovery can remove an interrupted write under the staging name recorded for that trial. A stop during creation of the recovery record itself can leave an incomplete administrator-owned trial directory. At that point the trial has published neither file. Preserve an unreadable recovery record for inspection.

#### Prove delivery after a private branch moves

Use a disposable branch with one writer. Keep its initial and intended successor revisions in private configuration. Verify the successor is a direct child of the initial revision. Confirm that the reader is available before starting the timed client. Use the enrolled desktop account on the intended machine and its own installed package digest.

1. Choose a fresh condition GUID. Run the protected `Test-InstalledCodexWatcher.ps1` with `-Stage Start -BranchWatch`, the condition as `-TrialId`, the installed digest as `-ExpectedPackage` and the reviewed qualification runner as `-SessionScript`. This starts a least-privilege desktop client. Check the model and raw ID in the trial’s `session/target.json`. Match the raw ID to the provider session named `relay-check-<trial-guid>`. Run `relay list --scope all --json` and verify one addressable Codex row for that ID. Use `-Mcp` and the reviewed client image and digest when exercising the MCP face. The enrolled desktop account needs read and execute access to the reviewed trial scripts for ordinary recovery.
2. As soon as the client publishes its target, run the protected `Test-InstalledBranchRead.ps1`. Supply `-PackageHash`, `-Endpoint`, `-Ref`, `-ExpectedRevision`, `-Edition`, `-ImageHash`, `-TransportHash` and `-ReaderUser` from the approved private trial configuration. Add `-MovementTarget <verified-raw-id> -MovementCondition <trial-id>`. Enter the reader credential at the masked prompt. The client must see the published grant within five minutes of writing `target.json`. Its UTC last-write time plus five minutes gives the publication deadline. Allow time for masked input and broker restart. If the client times out, restore the trial and start with a fresh condition. The client activates the exact grant when the broker makes it available. It closes and resumes the same thread. The movement grant lasts five minutes from issuance.
3. Wait for the protected verifier to report that the exact baseline matched. Confirm that `session/resumed.json` names the same raw ID and the resumed writer is addressable. The separate writer may now advance only the approved fixture ref from the expected initial revision to the prepared successor. Use an exact old-revision lease and independently verify the resulting hosted revision. Stop on a different head or a missed deadline.
4. Save the protected verifier’s final line, `Installed broker proved the branch-change notice in the granted thread.` It confirms consumption of the exact message. A queue acknowledgment or a baseline match alone leaves delivery unproved. The verifier restores reports-only mode and removes its credential and Git profile.
5. Before cleanup, inspect the desktop task in PowerShell. Use the same condition GUID as `$trialId` and save its last run time and result. Confirm that it ran during this trial and has finished.

   ```powershell
   $name = 'RelayWatcherTrial-' + ([guid]$trialId).ToString('N') + '-Session'
   Get-ScheduledTask -TaskName $name | Select-Object State
   Get-ScheduledTaskInfo -TaskName $name | Select-Object LastRunTime, LastTaskResult
   ```

   The client counts consumed user inputs in the exact disposable thread five seconds after it observes reports-only mode. It accounts separately for the known seed and, on MCP, the subscription turn. The count reads only thread-item metadata. Result `0` means one additional input and a successful archive. Result `20` means zero, `21` means extra inputs, and `22` means the count could not be verified. Any other nonzero result also leaves the trial unproved. Pass only with the protected verifier’s delivery line, the successful desktop result and the independently verified hosted successor. Keep the disposable thread free of other input.
6. With the broker restored, run `-Stage Cleanup -BranchWatch` with the original trial ID and package digest. Verify a fresh reports-only heartbeat, zero subscriptions and absence of trial artifacts. On credential interruption follow the revocation and guarded recovery procedure above. In movement mode the credential recovery ID is the condition GUID. The recipient’s raw thread ID is a separate value.

If the desktop runner is interrupted, retain its task result and exchange directory. In the provider's session history, independently match the name `relay-check-<trial-guid>` and recorded raw ID, archive that exact disposable session if necessary, and verify its archived state. If the session cannot be identified, preserve the exchange for inspection. From ordinary PowerShell under the enrolled desktop account, run the protected client script with `-Stage RecoverSession -BranchWatch -TrialId <trial-guid> -Target <verified-raw-id> -ExpectedPackage <installed-digest> -ArchiveVerified`. This checks the stopped task and removes only recognised files in that trial's exchange. Run elevated Cleanup afterward, supplying `-RecordedTaskResult <original-code>` when the original result was nonzero. Recovery preserves the failed trial's disposition. A new attempt takes a new condition GUID.

## Qualify access to an external process

Use elevated Windows PowerShell under the enrolled desktop user while the interactive desktop is signed in. Stage a reviewed, administrator-controlled copy of `Test-ProcessEndInstalledAccount.ps1`, `Install-CompletionWatcher.ps1`, and the `fixtures/ProcessEndProbeCommand.ps1` and `fixtures/ProcessEndObservation.cs` files together. Verify their hashes against the reviewed revision before launching the controller. Supply the installed package digest from the private deployment record. The broker must be running with empty grants, disabled delivery and an idle worker.

From that tool directory, run the desktop preflight first. It creates one temporary task and checks a disposable process with queryable identity and creation time. Each invocation takes a fresh trial ID.

```powershell
$preflightId = [guid]::NewGuid()
$preflightId   # Record this value in the private trial journal before continuing.
.\Test-ProcessEndInstalledAccount.ps1 -ExpectedPackage $expectedPackage -TrialId $preflightId
```

For the live check, repeat with `-RotateBrokerPassword` under the owner's authorization for the dedicated account. This rotates the account password once and passes it in memory to Task Scheduler to register a separate limited S4U observer. The enrolled watcher keeps its own registration. Allow up to two minutes. The target and observer confirm their expected non-administrative identities. The controller pins the disposable process through the open attempt and checks its exit control. No AI session or network notice is involved.

```powershell
$liveId = [guid]::NewGuid()
$liveId   # Record this second value in the private trial journal.
.\Test-ProcessEndInstalledAccount.ps1 -ExpectedPackage $expectedPackage -TrialId $liveId -RotateBrokerPassword
```

Require successful script completion and `enrolledBrokerLogon` and `ownHandleVerified` both true. A `desktopProcessAccess` value of `denied` is a conclusive access result and leaves external-process notifications disabled. A value of `granted` establishes read access to this fixture. The controller returns success after deleting its temporary tasks and checking the enrolled broker's fresh reports-only heartbeat. Any other outcome leaves the trial inconclusive.

After an interruption, give the private deployment maintainer the recorded ID, whether the rotation switch was present, the reviewed revision and the last completed step. Identify the two possible root tasks by their exact names, `RelayProcessEnd-<guid-without-hyphens>-Desktop` and `RelayProcessEnd-<guid-without-hyphens>-Observer`. Each description is the name up to the final suffix. The desktop principal is the enrolled desktop SID with interactive-token logon. The observer principal is the enrolled broker SID with S4U logon. Both have limited run level, zero triggers and a single hidden, noninteractive Windows PowerShell action from the system directory. The encoded argument is specific to the trial. Preserve the task definitions and ACLs privately. Leave a task intact if the maintainer cannot independently match its entire definition, including the encoded action, before removing it. Confirm reports-only health and use fresh IDs for a rerun.

## Deactivate and retain state

```text
Install-CompletionWatcher.ps1 -Mode Rollback
```

Rollback stops and removes the two managed tasks and disables the dedicated account. The package, account SID, grant policy and job database remain available for recovery. Apply with the original digest and `-RenewBrokerPassword` can reactivate the installation.

This installer is the watcher component of fleet setup. Mesh enrollment, SSH credentials, inbound receive policy and provider MCP registration are separate machine-setup operations. The watcher plan grants no authority to change them.
