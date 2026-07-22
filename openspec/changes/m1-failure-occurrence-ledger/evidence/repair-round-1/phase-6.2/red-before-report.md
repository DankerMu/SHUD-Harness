# Phase 6.2 invariant closure red-before evidence

- Date: 2026-07-19
- Frozen product source: `a370f8e3a510b34c47d642f10f7d095aa8bb4b26`
- Product source state: restored to the frozen head with a source-only
  `red-proof-phase62-final` stash; the final test diff in
  `red-before-tests.patch` remained present.
- The source-only stash was popped immediately after this single batched replay
  and dropped successfully; no `red-proof` stash remains.

## Focused command

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts ./packages/backend/src/routes/index.test.ts -t 'Phase 6\.2|S34-P62-04 compound settlement and release failure'
```

Result: exit 1; 1 pass, 4 fail, 561 filtered out, 22 assertions across 3
files.

Observed red failures:

1. A carrier reachable only through `cause` imported both inherited occurrence
   IDs into the outer operation before the outer body occurrence.
2. Combined edge/numeric-key exhaustion produced zero
   `numeric_key_budget_exceeded` occurrences instead of one.
3. The real idempotency authority wrapper release probe produced
   `body, final_release, body`; the last body occurrence was recreated after
   release, while the first body came from incidental cause-carrier adoption.
4. The backend finalizer/serializer hostile-Proxy subprocess did not terminate
   before the 3-second test watchdog; the watchdog killed the child with
   `SIGKILL` and the suite continued normally.

The existing S34 compound typed HTTP mapping row passed, confirming that the
new failures isolate invariant accounting/boundedness rather than changing the
public response payload.
