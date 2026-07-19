# Red-before evidence

- Base source SHA: `5a450a97f2a474af2f4db26bd9ee198adb7395ec`
- Test-only patch SHA-256: `a1ba6b7fe52986d3fa8a86329a5c94f0c340ec578c498e6764f19d8c6cc68ee0`
- Source diff check before the run: `git diff --quiet -- packages/core/src/domain/services/workspace-record-store.ts packages/core/src/domain/services/idempotency-service.ts` exited `0`.
- Source restoration: no source implementation diff existed yet, so no stash/reverse patch was necessary. `git stash list` had no `red-proof` entry before or after the run.

## Command

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'opt-in|recover restored transition artifacts'
```

## Complete Bun output

```text
bun test v1.2.19 (aad3abea)

packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts:

# Unhandled error between tests
-------------------------------
1 | (function (entry, fetcher)
              ^
SyntaxError: Export named 'conditionalDeleteJsonRecordWithCleanupPermitAndExactFailureSettlement' not found in module '/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/.worktrees/issue-108-exact-transition-retry/packages/core/src/domain/services/workspace-record-store.ts'.
      at loadAndEvaluateModule (1:11)
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [231.00ms]
```

The Bun test process failed (`1 fail`, `1 error`). The surrounding capture shell then reported `zsh: read-only variable: status` while trying to copy the pipeline status into a reserved zsh variable; that wrapper diagnostic occurred after Bun had emitted the complete failure above and did not alter the test run.

## Semantic failure reason

The unchanged base source has no explicit opt-in total conditional-delete seam. Test module collection therefore fails at the new import before any assertion can pass accidentally. The batched tests require the missing seam to expose recovered `deleted | missing | superseded` outcomes, preserve A/B physical identity, avoid settlement after initial terminal results, preserve ordered failure identity, and recover the public `completeRecord`/`failRecord` paths. This is the expected red state for the new contract.

## Round 1 class-fix red proof

- Fixed review head: `0cda5d0d434f0a96a39e4feb4a43ea229df6aba9`.
- Replayable test patch: `evidence/round-1-red-tests.patch`.
- Replayable patch SHA-256: `86aa55bc70835448b9c4de2ad9f9395e8c0b2af4b29e5c311ae38f83cbf9a066`.
- The implementation files had no working-tree diff when this batched red run was made. No stash was needed or created.

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Round 1'
```

Result on the unchanged fixed review head: `0 pass`, `399 filtered out`,
`5 fail`, `7 expect()`; process exit `1`.

The five independent assertion classes failed as intended:

- the post-rename commit hook was unreachable;
- the syscall-adjacent successor generation was never installed;
- parent/namespace authority failures were incorrectly recovered;
- pinned-proof/final-close failures were not observable;
- exact opt-in missing-after-sibling classification retained the legacy
  `superseded` result instead of the required `missing` convergence.

The patch also contains the complete public matrix and the S34 compatibility
expectation. Applying it to the fixed review head reconstructs the test tree
used for this red proof; it does not contain implementation changes.

## Phase 6.2 composition red proof

The Phase 6.2 tests were added while retaining the prior Round 1
implementation unchanged, then run as one batch:

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Phase 6.2'
```

Result before the Phase 6.2 source repair: `0 pass`, `406 filtered out`,
`2 fail`, `5 expect()`; process exit `1`.

- parent move-away/back followed by sibling create/delete returned recovered
  success, so the expected typed failure was never thrown;
- a later wrapper referencing the initial failure through its nested graph
  represented the initial identity three times instead of once.

The updated replay patch above contains these Phase 6.2 tests together with
the earlier Round 1 red tree. No test-only stash was created.

## Phase 6.2 re-audit red proof

The follow-up tests were added while the Phase 6.2 implementation remained
unchanged, then run together:

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Phase 6.2 re-audit'
```

Initial result: `0 pass`, `408 filtered out`, `2 fail`, `9 expect()`; process
exit `1`.

- moving the workspace root away and back, then mutating a sibling, retained
  exact authority and returned success instead of a typed safe-path failure;
- a writable caller-owned later error had its `cause` rewritten to
  `undefined`, proving that normalization still mutated caller state.

The final replay patch also contains the binding/idempotency-fold rows added
to the same re-audit matrix. It is test-only, reverses cleanly against the
final test tree, and contains no implementation source changes. No
`red-proof` stash was created.

## Depth-redesign diagnosis red proof (supersedes watcher/normalizer design)

Both diagnosis harnesses were run against fixed review head
`0cda5d0d434f0a96a39e4feb4a43ea229df6aba9` before the depth-redesign source
was applied. The harnesses are the reproducible test patch for this redesign;
their SHA-256 bindings are:

- delayed-watch test: `3e6e66da9d69e25786c100e3f95965d7be001873f69bf7a20af6110e66b7e636`;
- delayed-watch preload: `3fa1b360def82865e6bc1c263096a8cecefca465ecc5a8754330ebf70f9cb97d`;
- error-occurrence harness: `cf6f2bece0fea4407b609e8741173c6e78cb238cdd3fe14e8abf03e3f1474079`;
- error-occurrence runner: `0612c719ec23db17cffedc15ac1d912298888c02495740a3e0cbab1d1fefbbc1`.

```sh
npx --yes bun@1.2.19 test --preload ./.workplans/issue-108/diagnosis/path-authority/delay-watch-preload.ts ./.workplans/issue-108/diagnosis/path-authority/delayed-watch-authority-red.test.ts
```

Result: `0 pass`, `1 fail`, `5 expect()`; process exit `1`. Native rename was
recorded at about 14 ms, delayed callback delivery at about 196 ms, but the
old implementation returned `recovered/deleted` at about 114 ms. This proves
the fixed wait completed before the event that was supposed to authorize it.

```sh
sh .workplans/issue-108/diagnosis/error-occurrence/run-red-harness.sh
```

Result: `0 pass`, `3 fail`, `7 expect()`; process exit `1`. The old fold cloned
the exact typed root and reused a module-lifetime Error-brand observation, so
the exact-identity and fresh-fold rows failed. The third historical row
expected implicit adoption of a caller envelope; the corrected contract
intentionally reverses that assertion—bare caller envelopes remain roots and
only a trusted occurrence ref may adopt an inner typed value. No stash,
temporary source reversal, or `red-proof` entry was created.

## Phase 6.2 third-audit red proof

The third-audit tests were added before either confirmed source repair. The
unchanged Phase 6.2 re-audit implementation was then exercised in one batch:

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts -t 'Phase 6.2 third audit'
```

Result: `0 pass`, `411 filtered out`, `2 fail`, `4 expect()`; process exit
`1`.

- The deterministic pre-registration hook was absent, so the trusted-root
  and intermediate-directory move-away/back window was not injected and the
  direct store observation returned instead of throwing typed path safety.
- The direct writable caller-created `PreservedErrorCompensationEnvelope`
  was incorrectly claimed as store-owned; normalization removed the caller's
  semantic-primary entry from its `AggregateError.errors` array. The frozen
  and non-configurable rows would additionally reject that attempted rewrite.

No third-audit implementation change existed at the time of this run, so no
stash was needed or created. The final replay patch contains these tests plus
the earlier Round 1 and Phase 6.2 test tree only. Its final SHA-256 is
`da33158e222b60240dc3de705fa2b3b26f92c0437ada3ca378ca97e3202d772a`;
`git apply --check --reverse` succeeds against the final test tree.
