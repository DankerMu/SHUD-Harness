# Round 2 depth repair red-before evidence

- Date: 2026-07-19
- Frozen source: `b425a68aa6e3f886c424d439f48bb97ac05bac23`
- Product source state: frozen Round 2 reviewed source; only the named replay
  patches were applied for each recorded red run.
- No `red-proof` stash or retained temporary replay worktree remains.

## Core depth regression replay

Replay patch: `red-before-core-depth.patch`.

Command:

```sh
npx --yes bun@1.2.19 test openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/round2-depth-regression.test.ts
```

Result on `b425a68`: exit 1; 2 pass, 3 fail, 10 assertions.

The intended failures prove the frozen source lacked explicit carrier adoption,
order-independent numeric-key accounting with independent edge evidence, and
closure-branded authority transport. The phase row and the initial
untrusted/duplicate/stale/reordered row already passed on the frozen source;
they are retained as regression coverage, not claimed as behavioral red.

## Backend undefined-outcome replay

Replay patch: `red-before-backend-undefined.patch`.

Focused command:

```sh
npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts -t 'S29-P62-10 POST /api/tasks binds|Round 2 finalizer keeps undefined|Round 2 undefined authority reconciliation'
```

Result on `b425a68`: exit 1. The S29 source-adapter static assertion failed;
the finalizer treated an exact `undefined` rejection as success and returned
201 instead of 500; authority reconciliation lost the rejected occurrence and
reported an empty phase vector instead of `body, settlement`.

## Dirty-baseline red runs not represented as replay patches

The initial Round 2 test-first focused run on `b425a68` exited 1 with 13 pass,
9 fail, 556 filtered, and 195 assertions. Its intended red rows covered carrier
adoption, independent edge/numeric budgets, phase grammar, and the backend old
adapter; the first undefined row was initially a false green and was corrected
before the replay patch above was captured.

Subsequent dirty working-tree reds exposed the remaining real-producer closure:

- S31 initially produced `body, final_release` instead of `body, settlement`;
- the corrected S35 seam raised `FailureOccurrenceProtocolError: invalid_phase`;
- two budget rows omitted the numeric-budget occurrence;
- refresh-body produced `body, settlement, final_release` instead of
  `body, final_release, final_release`.

Those intermediate pre-source states were not preserved as commits or patches,
so they cannot be losslessly replayed and are not presented as replayable proof.
The final absent-overflow row passed when added because the corrected algorithm
already satisfied it; it is boundary coverage, not behavioral red evidence.
