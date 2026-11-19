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
- The current broker accepts job reports. Its installed worker accepts only a bounded exit status. The owner's resumed-thread exception covers a job ID and exit code or signal. A scheduled watch needs its own grant and proof of its delivery route.
- Next gate (§4.10): activate a privately defined UTC schedule by raw ID. Exercise first observation, coalesced missed ticks, restart, revocation and proof without a duplicate wake. Track fixture and installed results separately.
