# Phase 6.2 Round 2 test evidence

Recorded at `2026-07-22T01:35:28Z` for PR #106.

## Source binding

- Pre-change source: `5a450a97f2a474af2f4db26bd9ee198adb7395ec` (`chore: align M2 dependency bookkeeping`).
- First implementation commit: `fafd5259eccc8e79257dc2e5aa3b38ce125769ae` (`fix(core): bind recovery writes to observed generation (#79)`).
- Review-refined PR test patch: `a8bde64feda5e74be55ba9b1c388a06d910f9359` (`fix(core): bind generation recovery to exact observation (#79)`).
- Green head: `6d0aca420e583bfb2a828b022ef872f9f5f3689a` plus the Round 2 test-only working-tree patch recorded here.
- Final core test SHA-256: `7fd9a8281fc899125c5130928c060b2c28b9600846bd9bd1ba8e2f2cdd8a3a77`.
- Final backend test SHA-256: `499c33dcf69cd318bac1d519d3d72192a8696802e1c454eebd0cda5e4993cf64`.

The detached red worktree applied only
`git diff --binary 5a450a97f2a474af2f4db26bd9ee198adb7395ec..a8bde64feda5e74be55ba9b1c388a06d910f9359 -- packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`,
then added the final Round 2 assertion that every `completed_rollback` row observes the transition guard missing immediately after successor preservation/identity checks, before the completed-row replay and final resource diagnostics. The `fafd525` patch introduced the selected behavior matrix; `a8bde64` added the canonical-equal physical-generation rows. The later merge at the green head changed failure-carrier unwrapping, not the selected status/byte/guard/resource expectations; the hashes above bind the final checked test files.

## Red-before proof

The test-only patch ran in a detached temporary worktree at the pre-change SHA. Exact command:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'Issue79 Child A (stale fail-intent generation race classifies|completed rollback generation race classifies)'
```

Result: exit code `1`; `0 pass`, `17 fail`, `407 filtered out`, `51 expect()` calls, 17 selected tests across one file.

Expected pre-change failure classification for every selected PR #106 behavior row:

- All ten stale fail-intent generation-race rows failed at `expect(installed).toBe(true)` with `Received: false`: the old implementation did not reach the successor-install decision seam used by the generation-bound oracle.
- Completed rollback / `completed` failed because the old writer returned `TaskServiceError.code=record_schema_error` (`Completed idempotency record is immutable`) instead of accepting and replaying the installed completed successor.
- Completed rollback / `invalid_unsafe_result_ref` failed with `record_schema_error` instead of the required `record_malformed` classification.
- Completed rollback / `started`, `failed`, `canonical_equal_same_inode`, and `canonical_equal_replacement_inode` failed byte preservation: the old writer replaced the installed successor with its requested completed record.
- Completed rollback / `missing` failed the missing-path oracle because the old writer recreated a completed record.

The three completed-rollback compatibility rows (`mismatch`, `invalid_missing_result_ref`, and `malformed`) were intentionally excluded from the definitive red selection: an exploratory 20-row run showed those three were already green on the pre-change contract. They are coverage-only compatibility evidence, not claimed as historical red proof.

The detached worktree and its `node_modules` symlink were removed after the run. No patch file, temporary worktree, or stash remains.

## Green-after proof

The same exact 17-test selection ran against the final core test file at the current head and returned exit code `0`: `17 pass`, `432 filtered out`, `0 fail`, `139 expect()` calls, 17 tests across one file.

The broader focused core selection added all three compatibility rows, the unchanged sibling consumers, and S34-P62-06:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts --test-name-pattern 'IdempotencyRecord store/get/replay uses safe deterministic direct paths|IdempotencyRecord completed invalidation requires exact digest and result_ref|S29-P62-01/02 quarantine refuses non-exact completed authority and preserves replacement B|Issue79 Child A (stale fail-intent generation race classifies|completed rollback .* successor)|S34-P62-06/Child-A1 guard-recovery completed swap captures each rejection once'
```

Result: exit code `0`; `24 pass`, `425 filtered out`, `0 fail`, `218 expect()` calls.

The backend sibling oracle ran with:

```sh
npx --yes bun@1.2.19 test ./packages/backend/src/routes/index.test.ts --test-name-pattern 'POST /api/tasks replays same Idempotency-Key and body without duplicate snapshots'
```

Result: exit code `0`; `1 pass`, `158 filtered out`, `0 fail`, `11 expect()` calls.

## Task 1.5 unchanged-sibling audit

| Surface | Concrete oracle | Resource-baseline oracle | Result | Deviation |
| --- | --- | --- | --- | --- |
| `completeRecord` publish/replay | `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts` — `IdempotencyRecord store/get/replay uses safe deterministic direct paths`: one hashed record file, exact completed record, same-digest `completed` replay, and persisted `getRecord` equality | The same test captures and compares `workspaceRecordAuthorityDiagnosticsForTest()` and `workspaceRecordDirectoryBindingDiagnosticsForTest()` before/after | pass | no deviations |
| Same-key mismatch | Same core test: different digest returns exact `{ status: "mismatch", record }` while the completed record remains readable | Same pre/post authority and directory-binding comparisons | pass | no deviations |
| Invalidation without exact completed authority | `IdempotencyRecord completed invalidation requires exact digest and result_ref`: wrong result ref remains retryable `record_malformed`, wrong digest remains `idempotency_mismatch`, and the completed record is unchanged | Same test captures and compares both diagnostics | pass | no deviations |
| Quarantine without exact completed authority | `S29-P62-01/02 quarantine refuses non-exact completed authority and preserves replacement B`: tokenless, obsolete-result, and result-only calls reject and preserve B; transported exact authority still performs the established terminal quarantine behavior | Same test captures and compares both diagnostics after all refusal and exact-authority behavior | pass | no deviations |
| Keyed `POST /api/tasks` 201 -> 200 | `packages/backend/src/routes/index.test.ts` — `POST /api/tasks replays same Idempotency-Key and body without duplicate snapshots`: first `201`, replay `200`, identical TaskCard, one ID allocation, one list entry, one snapshot, one idempotency record | Same test captures and compares both diagnostics | pass | no deviations |
| S34-P62-06 | `S34-P62-06/Child-A1 guard-recovery completed swap captures each rejection once`: typed refusal and occurrence ordering remain exact; installed completed bytes are preserved and replay as `invalid_completed` | Existing oracle already captures and compares both diagnostics in the same test | pass | no deviations |

## Full verification

- `npx --yes bun@1.2.19 run test:core-services`: exit `0`; `481 pass`, `5 skip`, `0 fail`, `29632 expect()` calls, 486 tests across two files.
- `npx --yes bun@1.2.19 run test:backend-api`: exit `0`; `163 pass`, `0 fail`, `5096 expect()` calls, 163 tests across two files.
- `npx --yes bun@1.2.19 run typecheck`: exit `0`.
- `openspec validate m1-generation-bound-recovery --strict --no-interactive`: exit `0`; change valid.
- `git diff --check`: exit `0`.
- `git -C zero diff --quiet`: exit `0`.
- `git ls-files workspace`: empty.
- `git stash list` contains no `red-proof` entry.
- Allowed files contain no debug sentinel prefix.
- Temporary red worktree: removed; `git worktree list` contains only the main and PR #106 worktrees.

Inspected but unchanged sibling surfaces: production `workspace-record-store.ts`, all production services/routes, other OpenSpec changes, and #107 scope. Deviations: no deviations.
