# Verification

Current worktree: `.worktrees/issue-108-private-exact-settlement`

Branch: `codex/issue-108-private-exact-settlement`

Corrective-action base HEAD: `662151a043a1ee83e54611949e63fdafb7afc110`

Base: `5a9151affc8ab3a984120a727e488d663d24e8a0`

## Fixed-source binding

`7127f83f5f47ab2537edb4b57543da30aeb55047` is the pre-fix Round-1
source commit. It does not contain the C1 occurrence correction or the complete
watcher access-path oracle and is retained below only as historical Round-1
provenance. It is not the source binding for any corrective-action green result.

The production source used by the corrective-action green runs is exactly
`662151a043a1ee83e54611949e63fdafb7afc110`. The executable watcher-evidence
source is reproducibly defined as that commit plus the current binary diff for:

- `evidence/delay-watch-preload.ts`
- `evidence/delayed-watch-authority.test.ts`

The exact command

```sh
git diff --no-ext-diff --binary 662151a043a1ee83e54611949e63fdafb7afc110 -- \
  openspec/changes/m1-transition-artifact-exact-retry/evidence/delay-watch-preload.ts \
  openspec/changes/m1-transition-artifact-exact-retry/evidence/delayed-watch-authority.test.ts | shasum -a 256
```

produces patch SHA-256
`5b0c448070d24148d002ec9f6e1f2f5d76da3217e59bc5673f41d4dded6d77b6`.
The ledger and task wording do not affect executable source and are excluded
from that digest. The post-corrective-action commit does not exist yet and is
therefore intentionally not claimed here; the orchestrator can add its SHA
after committing.

## Corrective-action green

- Delayed watcher oracle and 16-path executable negative-control matrix: 2
  pass, 0 fail, 27 assertions. Production registered no watcher; named,
  default, namespace, and CommonJS access paths for `node:fs.watch`,
  `node:fs.watchFile`, `node:fs.promises.watch`, and `node:fs/promises.watch`
  were each actually invoked and recorded by the negative control.
- The original `node:fs` default `promises.watch` bypass probe: exit 0 and one
  exact `node:fs/promises.watch` path registration after abort cleanup.
- Base-compatible behavior harness: 2 pass, 0 fail, 12 assertions.
- C1 early permit-admission occurrence regression: 1 pass, 0 fail, 12
  assertions.
- Focused private-settlement/resource/consumer matrix: 8 pass, 0 fail, 143
  assertions.
- Core and root typecheck: exit 0.
- `openspec validate m1-transition-artifact-exact-retry --strict
  --no-interactive`: valid.

## Linux proof-drift timing repair

The `linux-base` failure at `3e93ed60ea85b0180871496957356d59fc5c7171`
was a test-only timing race. The private proof-drift regression restored its
hardlink or namespace mode after a one-millisecond timer, so Linux could run
that restoration before the settlement proof and incorrectly observe a
successful settlement. Production settlement logic and APIs are unchanged.

Before the repair, a focused 200-rerun attempt reproduced the race locally at
run 197: `captureThrownValue` reported `Expected a thrown value.` The repaired
fixture keeps the drift in place until the captured canonical settlement
promise has rejected, then restores the filesystem fixture. It invokes the
captured same-ticket settlement callable after rejection and proves that it
returns the same rejected promise without increasing either the pinned-proof
count or the private-unlink count.

- Focused repaired regression repeated 100 actual executions: 100 pass, 0
  fail, 3,200 assertions.
- Focused private-settlement/resource/consumer matrix: 8 pass, 0 fail, 155
  assertions.
- Full core-service suite: exit 0.
- Core and root typecheck: exit 0.
- `openspec validate m1-transition-artifact-exact-retry --strict
  --no-interactive`: valid.
- `git diff --check`, Zero cleanliness, workspace tracked-residue check, and
  `red-proof` stash check: clean.

## Historical Round-1 record

- The old ledger labeled its green worktree as `7127f83f5f47ab2537edb4b57543da30aeb55047`.
  Because that pre-fix commit cannot reproduce the later C1 repair, those
  counts are historical execution notes rather than a fixed-source green
  binding.
- Full core services: 453 pass, 5 platform-dependent skips, 0 fail across 458 tests; 29,409 assertions.
- Full backend routes: 163 pass, 0 fail across 163 tests; 5,094 assertions.
- Dedicated public failure-ledger suite: 37 pass, 0 fail; 484 assertions.
- Canonical public-ledger replay verifier: exit 0; canonical matrix 95/95 named scenarios passed (40 two-party races, 80 participant outcomes).

## Resource and compatibility boundaries

The early permit-admission regression asserts the action remains semantic primary, an exact raw `undefined` finalizer is appended once as `final_release`, the public generation remains byte-for-byte and identity-equal, the pinned descriptor closes once, and authority, cleanup-permit capacity, mutex, and directory-binding diagnostics return to baseline.

The consumer matrix drives the real `IdempotencyRecordService` owner-release path. Explicit missing and superseded convergence completes while preserving successor B; ordinary pre-mutation failure and an explicit convergence carried by the occurrence ledger both propagate. No `idempotency-service.ts` implementation change was required.

The change continues to consume `failureLedger`, `captureFailureFoldEntry`, `capturePostSettlementFailureFoldEntry`, and `preserveTaskServiceErrorFailureEntries` from the already-landed public ledger. It does not modify `compensation-error-preservation.ts`, `task-service-error-compensation.ts`, backend production/fixtures, or public-ledger tests/implementation.

## Repository hygiene

- `git diff --check`: clean.
- Zero remains pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; its gitlink and worktree are unchanged.
- No `red-proof` stash remains.
- The pre-existing untracked `.review-gate.json` was not touched.
