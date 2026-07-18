# Verification evidence

Verified on `2026-07-18 11:25:56 EDT` from branch
`codex/issue-108-exact-transition-retry` at base
`5a450a97f2a474af2f4db26bd9ee198adb7395ec`.

## Green tests

- Focused exact-settlement/service regressions:

  ```sh
  npx --yes bun@1.2.19 test packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'opt-in|recover restored transition artifacts|stale observed guard consumption'
  ```

  Result: `5 pass`, `394 filtered out`, `0 fail`, `94 expect()`.

- Full core service suite:

  ```sh
  npx --yes bun@1.2.19 run test:core-services
  ```

  Result: `394 pass`, `5 skip`, `0 fail`, `28612 expect()` across 399 tests.

- Keyed HTTP compatibility:

  ```sh
  npx --yes bun@1.2.19 test packages/backend/src/routes/index.test.ts --test-name-pattern 'idempotency digest includes defaulted created_by|same Idempotency-Key with different body'
  ```

  Result: `2 pass`, `152 filtered out`, `0 fail`, `35 expect()`; the route
  produced 201 for the first request, 200 for exact replay, and 422 for a
  different digest. The full `npx --yes bun@1.2.19 run test:backend-api` suite
  also exited `0`.

- Scoped core typecheck:

  ```sh
  npx --yes bun@1.2.19 x tsc --noEmit -p packages/core/tsconfig.json
  ```

  Result: exit `0` with no diagnostics.

## Repository and specification checks

- `openspec validate m1-transition-artifact-exact-retry --strict --no-interactive`:
  `Change 'm1-transition-artifact-exact-retry' is valid`.
- `git diff --check`: exit `0`.
- `git diff --quiet -- zero`: exit `0`.
- `git submodule status -- zero`: `-13e25c116c62411e6ee8a0ad67a6c53dc7c376c6 zero`.
  The leading `-` records that the pinned submodule is not initialized; no
  `zero/` or gitlink change was made.
- `git ls-files workspace | wc -l`: `0`.
- `git stash list | rg 'red-proof'`: no matches.

## Root checks and backend sibling diagnosis

The initial root run found the worktree's pinned `zero` submodule uninitialized.
The orchestrator materialized the repository-pinned
`zero@13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` without changing the gitlink.
Root `npx --yes bun@1.2.19 run typecheck` then passed.

The first full `check` exposed two deterministic S34 backend sibling failures.
The red loop, ranked hypotheses, confirmed cause, and narrow test fix are
recorded in `evidence/backend-s34-diagnosis.md`.  The tests now inject both the
initial post-mutation unlink failure and a distinct exact-settlement failure,
so they continue to exercise a genuinely unrecoverable release while the new
recoverable behavior remains covered by the core/public rows.

Independent orchestrator verification after that fix:

```text
focused S34 backend: 2 pass, 152 filtered, 0 fail, 52 expect()
root check: exit 0
backend API: 154 pass, 0 fail, 5030 expect()
backend WS: 34 pass, 0 fail
frontend: 20 pass, 0 fail
schemas: 6 pass, 0 fail
core services: 394 pass, 5 platform-conditioned skip, 0 fail, 28612 expect()
GLM provider: 60 pass, 0 fail, 553 expect()
```

The final root run therefore satisfies task 4.2; there is no remaining
environment or test blocker.

## PR #106 rebase gate

After #108 merges, PR #106 must rebase onto it, delete its branch-only
fresh-settlement and unconditional-second-settlement helpers, consume the
shared store outcome implemented here, and resume at its existing Round 3
review counter.
