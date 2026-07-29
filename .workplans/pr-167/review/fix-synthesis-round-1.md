# Phase 5 fix synthesis — Round 1

PR: #167
Round 1 reviewed SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`
Fixture: expanded, repair intensity high
Round ledger: 4 verified FIX_NOW findings; highest major; classes `data-integrity`, `contract`, `test-evidence`; gate none.

## Routing

- `RS-01` is CONFIRMED/DEFER to existing Issue [#162](https://github.com/DankerMu/SHUD-Harness/issues/162), whose exclusive scope is bounded worktree/staged-blob admission and traversal/read budgets.
- `CT-01` cross-entry aggregation is REFUTED: three independent seams are frozen; later slices aggregate.
- `DI-02` HEAD binding is REFUTED: Task 1.1a intentionally supports index/worktree authority before commit; Git/HEAD authority is downstream.

## Pattern escalation

Pattern escalation: yes

Failure classes: `data-integrity`, `contract`, `test-evidence`

Invariant: no public success may be emitted for an incomplete governed candidate set or invalid synthetic oracle, and every checked Task 1.1a ingress-bound claim must be executable at the frozen public seam without weakening the fixture.

Trigger: first major finding in a high-risk shared source-contract/public-checker boundary, affecting repeated candidate lanes and public evidence rows.

### Invariant Surface Inventory

- Shared helper roots: `lib/current-source.ts`, `lib/ingress.ts`, `lib/schemas.ts`, `lib/source-frame.ts`, `lib/checker.ts`.
- Public entrypoints: `check.ts --input ... --kind ...`; `check.ts --repository-root ... --check-current`.
- Read surfaces: Git index/config/gitfile/commondir/backlink, manifest, candidate worktree files, metadata, frame, sidecar, direct JSON files.
- Write/delete/overwrite surfaces: none in production checker; temporary test repositories only.
- Staging/publish/rollback surfaces: Git index and manifest comparison; no publication/rollback.
- Producer/consumer evidence boundaries: source record, identity projection, candidate manifest, exact synthetic frame/sidecar, success/error receipts.
- Stale-state/idempotency boundaries: index/worktree mismatch, untracked candidate lanes, missing mandatory inputs, repeated receipts/no-write.
- Unchanged downstream consumers: #165/#166/#161/#162 consume later; no production consumer.

Surfaces intentionally out of scope:

- HEAD/Git executable/profile/gate authority: #166 / Task 5.1.
- Worktree/staged aggregate traversal/read budgets: #162.
- Supply/state/evidence/runtime/production/network security: named downstream/non-goals.

### Regression matrix

- Untracked OpenSpec spec -> current-check exact failure.
- Untracked exact workflow -> current-check exact failure.
- Mandatory OpenSpec core file removed with synchronized manifest removal -> current-check exact failure.
- Excluded OpenSpec evidence and unrelated untracked path -> no false rejection.
- Every named frame/sidecar mutation -> public current-check exact failure, status/inventory unchanged, no child launch.
- Byte/depth/node/item exact and +1 -> frozen public contract behavior with real profile; never test-only relaxed claims presented as public proof.

## Fix group: data-integrity

Implement one rule-driven filesystem candidate inventory for spike, exact workflow, OpenSpec mandatory core files and recursive `specs/**/spec.md`; reject untracked/symlink/non-regular candidates and missing mandatory files even when the manifest/index are synchronously narrowed. Keep `evidence/**` and unrelated paths excluded. Add all regression rows above.

## Fix group: test-evidence

Route every frozen synthetic mutation (entry count/order/path/mode/content/framing/digest/trailing/truncation, including synchronized variants where applicable) through the public current-check seam with exact receipt, no-write/status and no-child evidence. Add public exact/+1 structural-bound evidence wherever the frozen contract is executable.

## Fix group: contract

The verified node/item conflict is mathematical under the frozen definition: every non-root JSON value consumes one item, so `nodes = items + 1`; profiles 2048/512 and 32768/8192 cannot independently reach node limits. Do not silently change or weaken the fixture. First seek a contract-preserving implementation. If none exists, return a proof of impossibility plus the smallest explicit oracle decision options; leave this group unresolved pending the required authority decision.

## Verification

- Focused contracts suite.
- All three public commands with exact receipts.
- Strict OpenSpec and full repository check.
- Scope/package/workflow/submodule/diff/stash/debug hygiene.
- Current-check before/after status identity.

Post-fix: Phase 6.2 invariant audit, then comprehensive Round 2.
