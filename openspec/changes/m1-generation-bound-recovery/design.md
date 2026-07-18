## Context

`writeFailedRecord` and `recoverCompletedRecordAfterRollbackFailure` both derive a terminal transition from a prior lookup. On `main`, their final mutable write can capture a new baseline after that decision. The record store already exposes `observeJsonRecordForCleanup` and `replaceJsonRecordAfterExactObservation`; this child must reuse that authority rather than extending the store-wide carrier/provenance machinery abandoned with PR #104.

Fixture level: expanded. Repair intensity: high. Project profile: SHUD-Harness.

## Goals / Non-Goals

**Goals:**
- An unchanged started generation transitions to failed/completed exactly once and remains replayable.
- A generation installed after the deciding observation is preserved byte-for-byte and classified through existing public error/result contracts.
- Existing same-key mismatch, invalid-completed, failed recovery, transition-guard cleanup, and task replay behavior stays stable.

**Non-Goals:**
- Completed-consumption post-fulfillment settlement and documentation; that is issue #79 Child B.
- New record-store publication primitives, carrier/provenance transport, cross-process ownership, or a production caller for the rollback-completion API.
- Capacity re-scoping (#82), error-taxonomy changes (#80), lane cleanup ordering (#81), or test-infrastructure work (#83).

## Decisions

1. Reimplement from `origin/main`; do not cherry-pick PR #104. The accepted store already supplies the required exact-observation primitive, while PR #104's later carrier and wrapper architecture is both unnecessary for this slice and terminally unreviewed.
2. The deciding service path must carry a record-store cleanup permit into `replaceJsonRecordAfterExactObservation`. A fresh `writeJsonRecord` after decision is forbidden.
3. Losing exact authority is a classification event, not permission to retry against the replacement as a new mutable baseline. A same-digest terminal replacement may be returned; mismatched or invalid completed replacements retain existing typed behavior.
4. Test through `createIdempotencyRecordService` and existing publication/observation hooks. No private-helper-only test seam and no new mock of internal modules.

## Risks / Trade-offs

- [The two writers share service helpers and error classification] -> one serial implementer owns the service and test files; no parallel code-writing.
- [A cleanup permit may leak on early classification/error exits] -> every race and error regression asserts authority diagnostics return to the pre-call baseline.
- [A narrow fix could silently alter callers] -> run the full core service suite and explicit sibling-consumer rows.

## Invariant Matrix

Governing invariant: once recovery decides from generation A, it may replace only A under its pinned authority; any generation B that appears before commit is preserved and classified, never adopted as a fresh mutable baseline.

Source-of-truth identity/contract: normalized workspace + scope + key path, `request_digest`, status/result_ref, observed physical generation, and record-store cleanup permit.

Surfaces:
- Producers: `writeFailedRecord` reached by stale fail-intent-guard recovery, and `recoverCompletedRecordAfterRollbackFailure` in `idempotency-service.ts`.
- Validators/preflight: replay/lookup classification, digest/result binding, exact observation comparison.
- Storage/cache/query: idempotency JSON record and cleanup permit; no store implementation change planned.
- Public routes/entrypoints: `lookupReplay` is the public seam that triggers stale fail-intent-guard recovery; `recoverCompletedRecordAfterRollbackFailure` is the second public seam; task route remains an unchanged consumer.
- Frontend/downstream consumers: completed replay and task creation; no frontend code change.
- Failure paths/rollback/stale state: missing, mismatched, invalid completed, superseded, malformed, writer failure, permit cancellation.
- Evidence/audit/readiness: focused public-service tests, core suite, typecheck/check, OpenSpec, git/submodule/workspace hygiene.

Regression rows:
- stale fail-intent guard + `lookupReplay` observes started A unchanged -> exact replacement writes failed A, returns `incomplete` with that failed record, consumes the stale guard, and restores guard/permit/authority diagnostics.
- completed rollback recovery observes started A unchanged -> exact replacement returns one completed record with the requested `result_ref`; replay returns the same bytes and diagnostics return to baseline.
- either writer observes started A, then same-digest valid completed B is installed after observation and before exact replacement -> B remains byte-for-byte unchanged; `lookupReplay` returns `completed` B and completed rollback recovery returns B.
- either writer loses A to different-digest B -> B bytes remain unchanged; `lookupReplay` returns `mismatch`, while completed rollback recovery rejects with `TaskServiceError.code=idempotency_mismatch`.
- either writer loses A to completed B with missing/unsafe `result_ref` -> B bytes remain unchanged; `lookupReplay` returns `invalid_completed`, while completed rollback recovery rejects with `TaskServiceError.code=record_malformed`.
- either writer loses A to byte-distinct same-digest started/failed B -> B bytes remain unchanged; stale-guard `lookupReplay` consumes the guard for lost A and returns `incomplete` B, while completed rollback recovery rejects retryably with `TaskServiceError.code=record_malformed` and status 409.
- either writer loses A to malformed bytes B -> B bytes remain unchanged; both public seams reject with the existing `TaskServiceError.code=record_malformed`, and the stale guard/record permit is settled without granting mutation authority over B.
- either writer loses A to a missing generation -> no replacement occurs; `lookupReplay` returns `missing`, while completed rollback recovery rejects with the existing missing-transition `record_malformed` contract.
- exact replacement writer failure before commit with A still current -> original writer failure remains the semantic primary, no partial terminal record is reported, and acquired cleanup permits/authority return to baseline; if a completed B caused that writer failure, the existing S34-P62-06 fail-closed identity error remains primary with the writer failure retained as compensation; committed-then-throw behavior is explicitly outside Child A and unchanged.
- normal `completeRecord` still publishes/replays one completed record; invalidation/quarantine still requires exact completed authority; keyed `POST /api/tasks` still returns 201 with one TaskCard on first creation and 200 with the identical TaskCard on replay while producing one snapshot; S34-P62-06 keeps the completed generation unchanged; every row returns diagnostics to baseline.

## Boundary-Surface Checklist

- Shared helper roots: existing observation/exact-replacement and service classification helpers; no new publication helper.
- Public entrypoints: `lookupReplay` through stale fail-intent-guard recovery, and `recoverCompletedRecordAfterRollbackFailure`.
- Read surfaces: lookup/replay and exact record observation.
- Write/delete/overwrite surfaces: only failed/completed recovery replacement.
- Staging/publish/rollback surfaces: cleanup-permit settlement and transition-guard cleanup.
- Producer/consumer evidence boundaries: observed generation/digest/result_ref must describe the bytes replaced.
- Stale-state/idempotency boundaries: replacement generation, invalid completed, contention, and reclassification.
- Unchanged downstream consumers: `completeRecord`, invalidation/quarantine, task create/replay.
