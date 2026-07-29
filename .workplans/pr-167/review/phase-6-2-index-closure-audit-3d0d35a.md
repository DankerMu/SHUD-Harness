# Phase 6.2 invariant audit — index-extension closure

PR: #167
Audited head SHA: `3d0d35a110ed66b80a2b4cca95b1028bfdc09853`
Invariant audit: findings

## Surface inventory

- Shared helper roots: clean — scope remains `contracts/lib/current-source.ts`.
- Public entrypoints: clean — exact current-authority receipts/no-child/no-write tests pass.
- Read surfaces: finding — entry boundaries, v4 prefix decoding, known extension envelopes, and global duplicate paths are checked, but global index ordering is not.
- Write/delete/overwrite surfaces: clean — implementation is read-only and tests preserve inventory.
- Staging/publish/rollback surfaces: out-of-scope for #164.
- Producer/consumer evidence boundaries: clean — manifest, filesystem candidates, index candidates, modes, and blob IDs cross-check.
- Stale-state/idempotency boundaries: clean — normal/linked v4 repeat tests preserve status/inventory.
- Unchanged downstream consumers: clean — no #162/#166 behavior introduced.

## Candidate finding

- P1 | `compatibility` | `readIndex` accepts a checksum-rehashed out-of-order Git index: it validates global duplicates but not predecessor ordering, then sorts candidate entries at return and hides malformed source order. | Evidence: `spikes/git-status-capability/contracts/lib/current-source.ts:139-191,206`; authority tests cover duplicate but not reorder cases. | malformed v4 (and v2/v3) index can emit public source authority if its candidate set still matches manifest. | require strict byte ordering across every decoded stage-0 path before candidate filtering; add normal/linked checksum-rehashed out-of-order public regressions and v2/v3 compatibility acceptance coverage.
