# Phase 6.2 invariant audit

PR: #167
Audited head SHA: `618bc86f1708513d3bf2666537fde0359019c800`
Failure classes: `data-integrity`, `contract`, `test-evidence`

Invariant audit: clean

## Governing invariant

No public success may be emitted for an incomplete governed candidate set or invalid
synthetic oracle; all Task 1.1a ingress-bound claims must be executable without
weakening frozen profiles or counting. With approved option 1, `nodes = items + 1`:
the public real-profile seam covers byte/depth/item and the unchanged node guard is
proved at the isolated parser seam with only its dominated item ceiling relaxed.

## Invariant Surface Inventory coverage

- Shared helper roots: out-of-scope because no shared/runtime helper changed; only isolated `contracts/lib/**` is involved.
- Public entrypoints: clean — all three #164 routes retain exact success/error receipt behavior and no partial success.
- Read surfaces: clean — bounded, fail-closed candidate/manifest/oracle reads cover the governed spike, workflow, mandatory change files, and `specs/**/spec.md`.
- Write/delete/overwrite surfaces: out-of-scope because Task 1.1a checker has no write surface or child helper.
- Staging/publish/rollback surfaces: out-of-scope because evidence publication is owned by later #162/Task 1.1e+ slices.
- Producer/consumer evidence boundaries: clean — synthetic literal/frame/sidecar are independently bound; direct kinds remain limited to the two #164 source projections.
- Stale-state/idempotency boundaries: clean — repeated current-source checks have identical receipts and preserve tracked/untracked inventory; manifest/index equality is exact.
- Unchanged downstream consumers: clean — future-owned kinds remain rejected and no state/decision consumer is introduced.

## Surfaces inspected

- `spikes/git-status-capability/contracts/lib/{current-source.ts,ingress.ts,checker.ts,schemas.ts,source-frame.ts}`
- `spikes/git-status-capability/contracts/tests/{current-source-authority.test.ts,source-ingress.test.ts,synthetic-oracle.test.ts,source-identity.test.ts}`
- `spikes/git-status-capability/contracts/{check.ts,contract-v1.json,source-input-v1.paths}`
- `openspec/changes/m2-capability-observer-spike/{proposal.md,design.md,tasks.md,specs/git-status-capability-spike/spec.md}`

## Verification and result

- Candidate manifest versus Git index: exact equality.
- Focused contract suite: 27 pass, 0 fail.
- Live `--check-current`: exact success receipt.
- `git diff --check`: pass.

Remaining findings: None.
