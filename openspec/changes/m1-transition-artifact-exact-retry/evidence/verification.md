# Verification

Current worktree: `.worktrees/issue-108-private-exact-settlement`

Branch: `codex/issue-108-private-exact-settlement`

Reviewed HEAD: `7127f83f5f47ab2537edb4b57543da30aeb55047`

Base: `5a9151affc8ab3a984120a727e488d663d24e8a0`

## Round-1 blocker closure

- Focused private-settlement/resource/consumer matrix: 8 pass, 0 fail, 143 assertions.
- Delayed watcher oracle plus executable negative control: 2 pass, 0 fail, 11 assertions. Production registered none of `node:fs.watch`, `node:fs/promises.watch`, or `watchFile`; the negative control registered all three.
- Base-compatible behavior harness on base source: 0 pass, 2 behavioral assertion failures after successful collection and fixture execution.
- The unchanged behavior harness on test HEAD: 2 pass, 0 fail, 12 assertions.
- Full core services: 453 pass, 5 platform-dependent skips, 0 fail across 458 tests; 29,409 assertions.
- Full backend routes: 163 pass, 0 fail across 163 tests; 5,094 assertions.
- Dedicated public failure-ledger suite: 37 pass, 0 fail; 484 assertions.
- Core and root typecheck: exit 0.
- Strict OpenSpec validation: valid.
- Canonical public-ledger replay verifier: exit 0; canonical matrix 95/95 named scenarios passed (40 two-party races, 80 participant outcomes).

## Resource and compatibility boundaries

The early permit-admission regression asserts the action remains semantic primary, an exact raw `undefined` finalizer is appended once as `final_release`, the public generation remains byte-for-byte and identity-equal, the pinned descriptor closes once, and authority, cleanup-permit capacity, mutex, and directory-binding diagnostics return to baseline.

The consumer matrix drives the real `IdempotencyRecordService` owner-release path. Explicit missing and superseded convergence completes while preserving successor B; ordinary pre-mutation failure and an explicit convergence carried by the occurrence ledger both propagate. No `idempotency-service.ts` implementation change was required.

The change continues to consume `failureLedger`, `captureFailureFoldEntry`, `capturePostSettlementFailureFoldEntry`, and `preserveTaskServiceErrorFailureEntries` from the already-landed public ledger. It does not modify `compensation-error-preservation.ts`, `task-service-error-compensation.ts`, backend production/fixtures, or public-ledger tests/implementation.

## Repository hygiene

- `git diff --check`: clean.
- Zero remains pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; its gitlink and worktree are unchanged.
- No `red-proof` stash remains and the replay verifier left no temporary worktree.
- The pre-existing untracked `.review-gate.json` was not touched.
