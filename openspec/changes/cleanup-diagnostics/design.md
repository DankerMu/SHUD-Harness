# Design

## Context

The default runner unwraps one AggregateError layer; the reporter prints messages/stacks and cause chains, not arbitrary nested errors properties. Harness aggregates currently lose deeper causes. Production rollback already carries errors; changing it or switching reporters is unnecessary. The one-shot identity injection in detached-shud-faults.test.ts is already merged and stays intact.

## Goals / Non-Goals

Governing invariant: every captured cleanup failure remains visible with its nested causes and native process context, and cleanup never crosses a quiescence gate merely to collect more errors. A failing finally cannot make an earlier body/pending error disappear.

Must preserve: existing cleanup sequence and stop-on-unproved-quiescence boundaries; all real process checks/signals/abort/done waits; original body-error identity when cleanup succeeds; expected rejection assertions; no skipped tests, retries, new sleeps or fixture-default changes.

Non-goals: production ownership/abort fixes, #343 historical group policy, #352 poll barriers, historical trace-free root cause claims, reporter configuration, broad cleanup completeness refactors or new runtime logging.

## Decisions

Use one test-only formatter/diagnostic error constructor reused across the existing harnesses, not copies or production safeCode (which intentionally hides arbitrary messages). Preserve original failure references and enumerate nested AggregateError.errors and Error.cause with cycle detection. The visible message/cause wrapper must survive default runner one-level unwrapping; merely setting cause on the outer aggregate is not sufficient evidence.

On cleanup failure capture a bounded synchronous native ps command containing pid,pgid,stat only, plus known execution identities from existing starts/records/test child observations. No command lines, environment values, credentials or raw data. A failed snapshot is explicitly unavailable with status/code and must not replace the original failure; unknown identity is stated, never fabricated. Capture at the failure boundary, not only after later teardown.

Preserve sequencing surface by surface: where detachedProducer terminateGroup or the target fault-test stopObservedChildren already stops on rejection, decorate/rethrow there without proceeding to later release. Existing collecting loops retain their current continuation behavior; diagnostic work must neither strengthen nor weaken it. No cleanup completeness refactor.

For the identity/spawn fault case, observe pending rejection immediately and preserve body failure separately. Only when cleanup fails compose the captured primary/pending error with that failure; if cleanup succeeds rethrow the original body error unchanged. Expected successful rejection assertions must still pass. Keep stopObservedChildren, pending wait, second stop and remaining cleanup in their current order.

Sibling surfaces: detachedProducer.cleanup, cleanupResources, submissionProducer.finish, settlingProducer.cleanup and pollFixture.close. Audit every wrapper for nested diagnostic survival; reuse the owner without importing a second implementation. Production detached-shud.ts/process-group.ts/process-identity.ts/shud-submissions.ts and public schema remain byte-unchanged.

## Required Evidence

Inject an abort rejection carrying nested aggregate/cause sentinels through actual fixture cleanup and capture default Vitest output before/after: old output omits inner diagnostics, new output includes each sentinel/stack and known pid/pgid plus ps context. Permanent tests cover nested/multiple/cyclic/non-Error failures, unavailable snapshot retaining original evidence, body-only same-object error and combined body/pending-plus-cleanup errors. Verify the per-surface order/stop table below, including both early fault-test stops. Existing native lifecycle assertions remain unchanged.

| Surface | Existing order and rejection behavior to preserve | Proof obligation |
|---|---|---|
| detachedProducer.cleanup | settle starts → groups sequentially; terminateGroup rejection stops before aborts/finish; otherwise collect abort rejections → finish | early group rejection remains stopping and gets diagnostics; abort diagnostics preserve existing continuation |
| cleanupResources | sequential actions, collect each rejection and attempt later actions | captured earlier errors survive a later error without changing action order |
| submissionProducer.finish | collect abort failures → finish | abort failure remains visible and finish ordering unchanged |
| settlingProducer.cleanup / pollFixture.close | retain existing collecting behavior: quiescence error may be collected before abort/finish/done; close then still attempts disposal/ownership-release/fixture disposal | preserve those specific continuation points, not a new universal stop policy |
| target spawn/identity finally | fault.mode reset → first stopObservedChildren → pending wait → second stopObservedChildren → execution.cleanup → h.dispose | each early stop can reject before aggregate wrappers; capture diagnostic at that failure, combine already-observed body/pending errors, and prove later cleanup remains unexecuted on early stop failure |

## Risks / Trade-offs

Diagnostics are produced only on failure and are test-only; do not claim production observability changes. Known-good cleanup adds no ps calls. Snapshot capture cannot become an unbounded hang and does not establish ownership or quiescence. Historical two failures without traces are not retrospectively explained; #313 causality remains unknown.

## Migration Plan

No runtime migration. The focused reporter probe is temporary and removed after evidence retention; permanent tests exercise diagnostic/error behavior, not source strings or reporter formatting. Revert the independent commit to roll back test infrastructure; no PI acceptance claim.
