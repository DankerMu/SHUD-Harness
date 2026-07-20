# Red-before evidence

## Round-1 occurrence regression

Reviewed source SHA: `7127f83f5f47ab2537edb4b57543da30aeb55047`.

Exact command:

```sh
npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern "early permit-admission action rejection keeps an undefined binding finalizer occurrence"
```

The test reached the early `permit_admission` rejection and resource assertions, then failed because `failureEvents` was `[]` instead of the ordered `initial_release` action and exact `undefined` `final_release`. Result: 0 pass, 1 fail, 8 assertions before failure. The unchanged command passes on the fixed source with 1 pass, 0 fail, 12 assertions.

## Base-compatible behavioral red

Base source SHA: `5a9151affc8ab3a984120a727e488d663d24e8a0`.

The test imports the base-available legacy conditional-delete seam as a fallback, so collection and fixture admission succeed without the new API. Only `packages/core/src/domain/services/workspace-record-store.ts` was stashed; that file was verified against the base blob before the red command and restored to `7127f83f5f47ab2537edb4b57543da30aeb55047` before the source stash was immediately popped.

Exact test command:

```sh
npx --yes bun@1.2.19 test openspec/changes/m1-transition-artifact-exact-retry/evidence/base-compatible-behavior.test.ts
```

Behavioral red output:

```text
(fail) base-compatible acceptance reaches public B preservation and terminal private settlement
Expected actionOutcome.status: "fulfilled"
Received actionOutcome.status: "rejected"
(fail) base-compatible acceptance reaches irreversible private proof drift assertions
Expected proofAttempts: 1
Received proofAttempts: 0
0 pass
2 fail
7 expect() calls
```

The first test reached and passed successor-B preservation plus authority/binding baseline assertions before rejecting the terminal `{ status: "recovered", settlement: "deleted" }` acceptance. The second reached the proof-monotonicity assertion instead of failing collection. On the restored test HEAD, the identical command passes with 2 pass, 0 fail, 12 assertions.

No `red-proof` stash remains.
