## 1. Generation-bound implementation

- [x] 1.1 Add public-service red-before/green-after races at two exact seams: (a) create a stale persisted fail-intent guard, call `lookupReplay`, pause after `writeFailedRecord` observes started A and before exact replacement, install byte-distinct same-digest completed B, then require `completed` B; (b) call `recoverCompletedRecordAfterRollbackFailure`, pause after it observes A and before exact replacement, install B, then require returned B. In both rows replay returns B, persisted bytes equal B exactly, the stale guard is settled when owned, and guard/permit/authority diagnostics equal the pre-call baseline.
- [x] 1.2 Bind both recovery writers to their deciding observation using existing `observeJsonRecordForCleanup` and `replaceJsonRecordAfterExactObservation` authority; do not add or modify a record-store publication primitive.
- [x] 1.3 For stale-guard `lookupReplay`, prove separately: unchanged A -> `incomplete` failed record and stale guard consumed; same-digest valid completed B -> `completed`; different-digest B -> `mismatch`; missing/unsafe-result completed B -> `invalid_completed`; byte-distinct same-digest started or failed B -> `incomplete` B with the guard for lost A consumed; malformed bytes B -> rejection with `TaskServiceError.code=record_malformed`; missing successor -> `missing`; writer failure while A remains current -> original failure is semantic primary; writer failure caused by completed B -> existing S34-P62-06 fail-closed identity primary plus writer compensation. Preserve exact B bytes, do not grant authority over B, and restore guard/permit/authority diagnostics in every applicable row.
- [x] 1.4 For `recoverCompletedRecordAfterRollbackFailure`, prove separately: unchanged A -> returned/replayed completed record with requested `result_ref`; same-digest valid completed B -> returned/replayed B; different-digest B -> `TaskServiceError.code=idempotency_mismatch`; missing/unsafe-result completed B -> `TaskServiceError.code=record_malformed`; byte-distinct same-digest started or failed B -> retryable `TaskServiceError.code=record_malformed` with status 409; malformed bytes B -> `TaskServiceError.code=record_malformed`; missing successor -> existing missing-transition `record_malformed`; writer failure -> original failure is semantic primary. Preserve exact B bytes, perform no mutation of B, and restore diagnostics in every applicable row.
- [x] 1.5 Audit unchanged sibling consumers with concrete oracles: `completeRecord` still publishes/replays one completed record; invalidation/quarantine still refuses mutation without exact completed authority; keyed `POST /api/tasks` first returns 201 with one TaskCard and replay returns 200 with the identical TaskCard while only one snapshot exists; same-key lookup remains `mismatch`; S34-P62-06 preserves the installed completed generation; all rows return authority diagnostics to baseline. Report inspected surfaces and deviations or state `no deviations`.

## 2. Risk-pack evidence

- [x] 2.1 Public API / CLI / script entry: selected — both recovery service methods are callable contracts; prove behavior through `createIdempotencyRecordService`.
- [x] 2.2 Config / project setup: not selected — no configuration or workspace-layout change.
- [x] 2.3 File IO / path safety / overwrite: selected — exact observed generation is the only legal replacement target; assert installed B bytes are unchanged.
- [x] 2.4 Schema / columns / units / field names: selected — preserve `status`, `request_digest`, `result_ref`, timestamps, and existing Zod validation without shape changes.
- [x] 2.5 Auth / permissions / secrets: not selected — no credential or authorization surface.
- [x] 2.6 Concurrency / shared state / ordering: selected — cover both decision-to-write races and unchanged/contended schedules.
- [x] 2.7 Resource limits / large input / discovery: selected — assert guards, cleanup permits, and authority diagnostics return to baseline on every tested exit.
- [x] 2.8 Legacy compatibility / examples: selected — full core service suite plus explicit unchanged callers.
- [x] 2.9 Error handling / rollback / partial outputs: selected — exact primary errors, no partial overwrite, and cleanup settlement on all losing-authority paths.
- [x] 2.10 Release / packaging / dependency compatibility: not selected — no dependency, package, or generated-artifact change.
- [x] 2.11 Documentation / migration notes: not selected — no user migration or public documentation change in Child A.
- [x] 2.12 Scientific governance / PI gate / evidence lineage: not selected — no scientific behavior or evidence classification.
- [x] 2.13 Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected — solver/toolbox/pipeline untouched.
- [x] 2.14 Zero adapter / tool registry / agent role governance: not selected — Zero and governance surfaces untouched.

## 3. Verification

- [x] 3.1 Run the focused new tests red against pre-change source and green after restoration; leave no `red-proof` stash.
- [x] 3.2 Run `bun run test:core-services`, `bun run typecheck`, and `bun run check`.
- [x] 3.3 Run `openspec validate m1-generation-bound-recovery --strict --no-interactive`, `git diff --check`, `git -C zero diff --quiet`, and verify `git ls-files workspace` is empty.
