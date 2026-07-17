# Issue #79 — Completed Record Immutability Follow-up

- [x] 1. Add red-first public-service race regressions at the existing publication/observation hook seam:
  - plain failed recovery observes started A, then a byte-distinct same-digest completed B is installed before mutation -> the call returns/reclassifies to B, subsequent replay returns B, persisted bytes equal the installed B bytes exactly, and workspace authority/cleanup-permit diagnostics equal the pre-call baseline;
  - `recoverCompletedRecordAfterRollbackFailure` observes started A, then completed B is installed in its check-then-act window -> the call and subsequent replay return B, B's result_ref/timestamps/full bytes are unchanged, and no guard/permit/authority remains outstanding.
- [x] 2. Bind both recovery writers to their deciding generation using existing observation/exact-replacement or transition-guard authority; do not add a publication primitive. Add compatibility rows:
  - unchanged started A -> failed recovery returns one failed record, completed rollback recovery returns one completed record, and replay sees the same terminal record;
  - replacement with a different request digest -> existing idempotency mismatch error, no mutation;
  - malformed/invalid completed replacement -> existing invalid-completed typed error, exact bytes preserved;
  - existing S34-P62-06 in-band schedule -> unchanged completed generation and zero authority-capacity drift.
- [x] 3. Close and pin all post-fulfillment settlement contracts:
  - inject failure at each of the three exits (transition-artifact release, defensive authority-state validation, cleanup-permit refresh) -> transported mutation authority and rejected-reason resources settle exactly once, diagnostics return to baseline, and the injected failure remains the semantic primary with settlement failures only as compensation;
  - source-structure pin enumerates all three exits and verifies each invokes the shared settlement owner;
  - observation-seam doc pin requires the committed-then-throw fail-loud contract while runtime record-store behavior stays unchanged;
  - S34-P62-16 remains green for primary-once behavior.
- [x] 4. Audit sibling idempotency writers and unchanged consumers against the Invariant Matrix: `completeRecord`, `invalidateCompletedRecord`, quarantine, task create/replay, same-key mismatch, and failed recovery must keep their existing outputs/errors; record inspected surfaces and any deviation from this fixture or state `no deviations`.
- [x] 5. Verify: focused new regressions red-before/green-after; `bun run test:core-services`; `bun run typecheck`; `bun run check`; `openspec validate m1-completed-record-immutability-followup --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`; `test -z "$(git ls-files workspace)"`.

Evidence mapping:
- File IO + concurrency + rollback: tasks 1–2, replacement-race regressions and full core suite.
- Schema + legacy compatibility: tasks 2 and 4, explicit mismatch/invalid-completed/uncontended/replay outputs.
- Resource limits/settlement: tasks 1 and 3, before/after authority diagnostics and exact-once settlement for all three exits.
- Public service API: tasks 1–2, tests call exported recovery methods rather than private helpers.
- Error handling: tasks 1–3, installed B survives every race and injected failure remains semantic primary.
- Documentation: task 3, source-structure pins for all three windows and committed-then-throw seam contract.
