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
