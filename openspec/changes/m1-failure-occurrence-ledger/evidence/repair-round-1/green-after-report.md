# Round 1 repair green and verification evidence

- Date: 2026-07-19
- Working branch: `codex/issue-108-ledger-foundation`
- Frozen reviewed source: `1a993c89c842b72512768c40b87dd2205562ac05`

## Identical red/green command

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts
```

Result: exit 0; 17 pass, 0 fail, 170 assertions across 2 files.

## Full affected suites

- Core services: exit 0; 403 pass, 5 skip, 0 fail, 28,621 assertions
  across 2 files.
- Backend API, serial run: exit 0; 157 pass, 0 fail, 5,035 assertions
  across 2 files.
- Real-producer phase/order rows: TaskCard create/rollback and idempotency plus
  workspace release paths passed together (4 pass, 141 assertions); the backend
  observation finalizer row passed (1 pass, 19 assertions). The authority
  transport-wrapper batch also passed (7 pass, 98 assertions).
- The one backend capacity test that failed while core and backend stress
  suites were intentionally run concurrently passed alone (1 pass) and in the
  serial full backend run. It is treated as test-host resource contention, not
  a product regression.

## Repository matrix

- `npx --yes bun@1.2.19 run typecheck`: exit 0.
- `test:policy-gate`: 430 pass, 0 fail.
- `test:tool-registry-governance`: 11 pass, 0 fail.
- `test:backend-ws`: 34 pass, 0 fail.
- `test:frontend`: 20 pass, 0 fail.
- `test:schemas`: 6 pass, 0 fail.
- `test:glm-provider`: 60 pass, 0 fail.
- `openspec validate m1-failure-occurrence-ledger --strict --no-interactive`:
  exit 0 (`Change 'm1-failure-occurrence-ledger' is valid`).
- Test-declaration retention against the frozen source: giant core 381/381 and
  backend 154/154; dedicated core grew 8 to 14 and dedicated backend 2 to 3.
  Static-name comparison reports zero missing names in all four files; no
  pre-existing test declaration was removed.
- `git diff --check`: exit 0; `git stash list` contains no `red-proof` stash.

The implementer observed one aggregate `bun run check` invocation remain at
high CPU after its last visible assertion and interrupted it after about eight
minutes. The orchestrator then reran the exact aggregate command serially on
the same worktree: it exited 0, including 403 core passes with 5
platform-conditioned skips, 157 backend passes, and all other component suites.
The hang did not reproduce and no product/test fix was made for it.

## Orchestrator Phase 2 recheck

- Dedicated ledger/backend command: exit 0; 17 pass, 0 fail, 170 assertions.
- Full core services: exit 0; 403 pass, 5 skip, 0 fail, 28,621 assertions.
- Full backend API: exit 0; 157 pass, 0 fail, 5,035 assertions.
- Typecheck, strict OpenSpec validation, `git diff --check`, and stash hygiene:
  exit 0 / clean.
- Default `npx --yes bun@1.2.19 run check`: exit 0; all component suites
  completed, including the final 60-pass GLM provider suite.
