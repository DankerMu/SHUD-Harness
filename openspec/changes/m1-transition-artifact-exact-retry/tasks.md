## 1. Depth-redesign contract amendment

- [x] 1.1 Amend the active proposal, design, and delta spec from public restore/re-isolation and recovered missing/superseded to first-private-isolation ticket settlement with public observation-only semantics.
- [x] 1.2 Specify operation-owned immutable occurrence ledgers, exact typed roots, fresh fold observation, explicit trusted adoption, and separate node/edge/event/ordered-distinct semantics.
- [x] 1.3 Record `review-failure-retro-same-invariant-1.md`, `diagnosis/path-lifecycle/report.md`, and `diagnosis/error-occurrence/corrected-report.md` as the internal correctness reason; preserve public and persisted contracts.

## 2. Private generation settlement ticket

- [x] 2.1 Add the store-private monotonic one-consumer ticket after first rename and exact private proof; default callers keep legacy restoration.
- [x] 2.2 Make opt-in post-isolation failure hand off and settle only private A; remove watchers, fixed waits, public restore callback, and public re-isolation from that chain.
- [x] 2.3 Type and test private missing/link drift/replacement/namespace drift, transient and permanent unlink, namespace cleanup and close failures, repeated settle/release, and occurrence ordering.
- [x] 2.4 Migrate transition guard/cleanup-lock producers and consumers without changing non-opt-in or public HTTP behavior.

## 3. Failure occurrence ledger

- [x] 3.1 Implement phase-tagged occurrences, exact primary, identity-unique graph nodes, raw alias/edge metadata, ordered distinct values, fold-local observation, non-Error carrier, and private sidecar provenance.
- [x] 3.2 Replace raw graph snapshot/pruning/normalization and typed cloning with exact trusted ledger views; keep caller envelopes fail-closed unless explicitly adopted.
- [x] 3.3 Migrate workspace, idempotency/task-card, and backend typed consumers so no naturally affected call chain mixes raw-envelope and ledger occurrence semantics.

## 4. Red/green and verification

- [x] 4.1 Run both diagnosis red harnesses against the superseded source and record a reproducible red patch/output before restoring the redesign.
- [x] 4.2 Cover the complete private-ticket and ledger matrices, including zero watcher registration/no event wait and backend typed HTTP view.
- [x] 4.3 Run focused greens, full core services, full backend routes, root/core typecheck, root check, strict OpenSpec, and diff/submodule/workspace/stash hygiene.

<!-- Superseded Round 1 checklist retained below as historical evidence only. -->

## Historical Round 1 checklist

- [x] 1.1 Add batched red-before tests against `origin/main`: call the opt-in store seam and public `completeRecord`/`failRecord`/stale-guard seams with restored A, missing, different-field B, same-field/new-inode B, initial success followed by B, and settlement failure; record base SHA, test patch/hash, exact command/output, expected returned outcome/error tree, and semantic failure reason.
- [x] 1.2 Add an opt-in generation-aware conditional-delete mode/primitive with explicit initial results plus `recovered { settlement: deleted | missing | superseded }`; retain the original permit snapshot and perform at most one exact-A settlement before the authority lease releases, while keeping every existing delete entrypoint and default result unchanged.
- [x] 1.3 Return missing/superseded settlement as convergence without touching B; never use JSON/schema equality, service `stat`, or a fresh cleanup permit as authority over original A.
- [x] 1.4 When exact settlement and final release succeed, return recovered without throwing the initial post-mutation marker; otherwise preserve initial marker primary and append distinct settlement then authority-release errors once in occurrence order. Terminate permit/FD/capacity/mutex/binding ownership on every exit.
- [x] 1.5 On current `main`, move shared roots `releaseOwnedIdempotencyTransitionArtifact` and `consumeObservedIdempotencyTransitionArtifact` to the opt-in operation and remove writable fresh-observation recovery from `recoverOwnedIdempotencyTransitionGuardAfterTerminalReleaseFailure`; preserve legacy artifact shapes and public successful/error contracts.
- [x] 1.6 Audit sibling boundaries from the design table. Keep generic conditional delete, writable probe/store publication compensation, TaskCard observed/published cleanup, validation, exact settlement, and publication-authority transfer on default semantics; prove each group with a representative compatibility test.

## 2. Required regression evidence

- [x] 2.1 Store seam: inject failure after canonical isolation, restore exact A, and require `recovered/deleted`, A absent, caller fulfilled, one descriptor close, and repeated terminal use rejected without current-path authority.
- [x] 2.2 Store seam: after restoration install missing, different-field B, same-field/new-inode B, same-inode byte drift, special-file/hardlink, or parent rebound; require recovered/missing or recovered/superseded where applicable, exact foreign bytes/dev/ino unchanged, and stable typed failure otherwise.
- [x] 2.3 Public guard and cleanup-lock seams: initial successful release followed immediately by B returns the existing fulfilled `completeRecord`/`failRecord` result, performs no second settlement, and preserves B.
- [x] 2.4 Failure algebra: inject service body, initial post-mutation delete, exact settlement, and final lease/resource release failures; assert body → initial → settlement → release order, identity once, and hostile wrapper/accessor cannot replace semantic primary.
- [x] 2.5 Public compatibility: prove `completeRecord({ scope, key, requestDigest, resultRef })` returns the completed `IdempotencyRecord` with original identity/creation fields, supplied `result_ref`, and new `updated_at`; `failRecord({ scope, key, requestDigest })` returns the failed record with no `result_ref`; `lookupReplay` returns exact `missing | mismatch | incomplete | completed` variants; malformed guard returns `record_malformed/500` with bytes preserved; mismatched fail-intent returns `record_malformed/409`; legacy identity-only guard returns the unchanged completed replay; hardlink/special malformed rollback returns non-retryable `record_malformed` and preserves the entry; parent rebound returns `workspace_path_not_safe/500`; keyed task remains HTTP 201 first response → 200 exact replay and 422 `idempotency_mismatch` for a different digest.
- [x] 2.6 For every row assert exact bytes/dev/ino or absence, guard/cleanup-lock paths, replay/public result, FD close count, cleanup-permit/capacity, authority mutex, directory binding, and owned namespace diagnostics return to baseline.

## 3. Risk-pack mapping

- [x] 3.1 Public API / CLI / script entry: selected — additive store API and public service consumers; prove existing signatures/results plus new opt-in contract.
- [x] 3.2 Config / project setup: not selected — no configuration or layout change.
- [x] 3.3 File IO / path safety / overwrite: selected — exact physical delete, restoration, symlink/hardlink/special-file and parent binding preservation.
- [x] 3.4 Schema / columns / units / field names: selected — no persisted shape change; field equality must never become physical authority.
- [x] 3.5 Auth / permissions / secrets: not selected — no credential/permission surface.
- [x] 3.6 Concurrency / shared state / ordering: selected — A/B replacement, admission, retry, cancellation, error and release ordering.
- [x] 3.7 Resource limits / large input / discovery: selected — one bounded settlement and exact FD/permit/capacity/binding baselines.
- [x] 3.8 Legacy compatibility / examples: selected — old artifacts and default conditional-delete callers retain behavior.
- [x] 3.9 Error handling / rollback / partial outputs: selected — restored A, missing/superseded convergence, primary/compensation contract.
- [x] 3.10 Release / packaging / dependency compatibility: not selected — no dependency/package/generated artifact change.
- [x] 3.11 Documentation / migration notes: not selected — additive internal contract with no operator migration; OpenSpec is the implementation record.
- [x] 3.12 Scientific governance / PI gate / evidence lineage: not selected — no scientific behavior/evidence claim.
- [x] 3.13 Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected — solver/toolbox/pipeline untouched.
- [x] 3.14 Zero adapter / tool registry / agent role governance: not selected — root core only; `zero/` must remain unchanged.

## 4. Verification

- [x] 4.1 Run focused new store/service tests red against pre-change source and green after restoration; leave no `red-proof` stash or temporary harness.
- [x] 4.2 Run `npx --yes bun@1.2.19 run test:core-services`, `npx --yes bun@1.2.19 run typecheck`, and `npx --yes bun@1.2.19 run check`.
- [x] 4.3 Run `openspec validate m1-transition-artifact-exact-retry --strict --no-interactive`, `git diff --check`, verify zero `zero/` and submodule diff, and verify `git ls-files workspace` is empty.
- [x] 4.4 Record the PR #106 rebase gate: after #108 merges, rebase #106, delete branch-only fresh-settlement/unconditional-second-settlement helpers, consume the new store outcome, and continue #106 at its existing Round 3 counter.
