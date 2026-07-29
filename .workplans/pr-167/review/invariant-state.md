# Round 1 — Invariant / State / Compatibility

Reviewer agent: `issue164_r1_invariant`
Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

Summary: two blocking P1 candidates; no state/cache/storage semantics were introduced and future vocabularies fail closed.

## Findings

### P1 — Current source set is not closed across OpenSpec/workflow and mandatory files

- Failure class: `data-integrity`
- Invariant: manifest must include all candidate source inputs and mandatory OpenSpec files.
- Scenario: untracked new spec/workflow succeeds; alternatively staged-delete `proposal.md` and remove its manifest line, leaving index/manifest/spike mutually consistent and receiving success.
- Evidence: spec mandatory-set requirements; `current-source.ts` only scans `spikes/**` and trusts index/manifest for other lanes.
- Consequence: source preimage can omit added or mandatory governance/spec input.
- Fix: rule-driven enumeration of every covered lane and explicit mandatory-file presence while excluding `evidence/**`.
- Required proof: untracked spec/workflow and synchronized mandatory deletion all fail at public seam.
- Siblings: later mechanical manifest regeneration/tasks.
- Blocks merge: yes.

### P1 — Production node limit is unreachable

- Failure class: `contract`
- Invariant/scenario/evidence/consequence/fix/proof: same dominated node/item profile defect as resource review; real profiles return item limit and tests raise item budgets.
- Siblings: all future profile owners.
- Blocks merge: yes.

## Matrix / limits

Producers and peer/oracle identity covered; validators have complete-set and bound findings; storage/cache none; only owned entrypoints exposed; later children remain separate; ordinary receipts/no-write hold but partial set can false-succeed; focused suite 24/24. Concurrent Git authority belongs #166, aggregate evidence budgets #162, state semantics #161; network excluded.
