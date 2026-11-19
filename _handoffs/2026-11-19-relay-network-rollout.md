# Cross-agent relay rollout

Resume from the first open gate in the active phase. Update this record when implementation, verification or deployment changes. Keep deployment identifiers, credentials, session IDs and private condition definitions outside this repository.

[Approved design and qualification gates](../docs/superpowers/specs/2026-11-18-cross-agent-relay-network-design.md)

| Phase | Evidence | Open work |
| --- | --- | --- |
| A and B · addressing, proof and health | Both desktops qualified a temporary restricted SSH route for Codex inventory, send and transcript proof. Both providers received live probes using the baseline transport. See design §11. | Permanent enrollment belongs to H. Restricted remote Claude delivery requires enforcement of recipient, payload and call count before the tool acts. |
| I, including C · watcher and command completion **(active)** | Both installed brokers issued a bounded grant and proved a job exit notice in a resumed Codex thread. Both returned to reports-only mode. Revoking a live job grant removed it from the same broker's heartbeat before expiry. See §4.10 and `f776f7f`. | Raw-ID scheduled watches first. File, branch, process and session transitions, cross-host notices, private tails and provider-specific rollout gates remain. |
| F, including E · registry and names | Raw IDs already address sessions directly. | Exclusive local leases, observed and reported fields in `who`, authorized rebinding, visible pauses and raw-ID pause notices. |
| G and H · capabilities, discovery and setup | Doctor collects dated provider evidence. Watcher installation and disposable SSH qualification cover parts of setup. | Capability evidence, tagged network discovery, directory fallback and permanent fleet enrollment. |
| D · machine signatures | A has durable request reservations. | Message signatures, signed receipts, trust revision and revocation, replay and per-peer rollout. |

## Current checkpoint

- Both desktop checkouts and the published branch reached `f776f7f`. Each desktop passed 352 relay tests and two installer tests. One opt-in check was skipped. The separate live revocation trial used a waiting fixture job and generated zero model turns.
- The installed worker accepts bounded job exit status. The owner also approved a separately granted fixed notice for a resumed writer of the same raw Codex thread: “A scheduled check is due. No reply is needed.” The notice carries no condition name, time, path or private content. This decision authorizes implementation. Installed schedule delivery still needs its own qualification.
- Next gate (§4.10): activate a privately defined UTC schedule by raw ID. Exercise first observation, coalesced missed ticks, restart, revocation and proof without a duplicate wake. Track fixture and installed results separately.
- Both desktops reached `0312451`. Each passed 358 relay tests and two installer tests with one opt-in test skipped. Fixture coverage includes the real broker socket, fake clock, durable store, missed ticks, changed grants, wrong recipient, revocation, restart and proof.
- Both desktops also ran `Qualify-CodexCompletion.mjs --schedule` with a disposable low-effort Codex thread and the source broker store. Each due tick produced zero submissions while its writer was absent. After store restart and writer resume, each trial submitted one fixed notice and proved it in the original thread.
- At `356bd9f` both desktops migrated their installed watcher. The updater verified all eight changed module inputs and all retained package hashes. Both brokers restarted in reports-only mode. The installer fixture restored the preceding module tree on a failed heartbeat and recovered an interruption between directory renames.
- Next gate: prove CLI activation and transcript arrival through each installed worker. Arm a single future UTC tick with the worker disabled, resume the disposable writer, verify its pre-tick cursor, then enable delivery. Restore empty policy and reports-only operation after the trial.
