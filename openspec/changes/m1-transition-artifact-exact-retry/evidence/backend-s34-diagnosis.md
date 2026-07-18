# Backend S34 diagnosis

## Red feedback loop

Command run after the issue #108 implementation and after initializing the
repository-pinned `zero@13e25c1` submodule:

```sh
npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'S34-P62-01 guard-release failure settles every transported rejected-decision resource on the malformed arm|S34-P62-01 guard-release failure settles the missing-arm cache claim without per-retry growth'
```

Stable result: exit `1`, `0 pass`, `152 filtered out`, `2 fail`, `9 expect()` in
445 ms.  The malformed arm expected the original compact completed-record
bytes but observed the canonical failed-record rewrite.  The missing arm
attempted to `unlink` the guard and received `ENOENT`.

## Minimal reproduction and confirmed cause

Both tests inject one exception from `beforeAuthorityOwnedUnlink` after the
completed-authority decision is fulfilled.  Before #108 that post-mutation
exception escaped guard release.  The tests therefore expected the completed
record and guard to remain for a later retry.

With #108, the store restores exact physical A and settles it inside the same
cleanup-permit admission.  The injected initial exception is recovered, guard
release succeeds, and the guard is absent.  The fulfilled rejected decision
then reaches the existing authority invalidation path, which durably rewrites
the record as failed.  The observed `ENOENT` and changed record bytes are the
direct consequences of the new required recovered-success algebra, not an
unauthorized B adoption or resource leak.

Ranked alternatives were checked against the call path:

1. Confirmed: the old injection no longer creates an unrecoverable release
   failure because exact settlement succeeds.
2. Refuted as a bug: the record rewrite is the existing
   `settleRejectedCompletedTaskAuthority` invalidation after successful
   consumption; semantic record/replay authority is not silently corrupted.
3. Refuted for this reproduction: terminal recovery and its cleanup-lock path
   are not entered when the exact settlement returns recovered success.
4. Refuted by the approved contract: propagating a recovered initial failure
   would violate the fixture's fulfilled-result requirement.

## Fix brief

Keep the S34 sibling purpose by making its failure genuinely unrecoverable:
nest `runWithWorkspaceRecordCompensationTestHooks` around the existing
publication-hook injection and throw a distinct marker from
`beforeExactFailureSettlement` for the same guard path.  Then the original
post-mutation release failure remains primary, the settlement failure is its
ordered compensation, the exact restored guard remains for the test's manual
staleness simulation, and the pre-existing bytes/resource assertions remain
meaningful.  Do not change production code.  Re-run the focused two-test loop,
full backend suite, root `typecheck`, and root `check`.
