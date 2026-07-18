## Context

`WorkspaceRecordCleanupPermit` retains the observed parent binding, physical generation, pathname epoch, bytes, and pinned descriptor while outstanding. A terminal delete claims the permit and its lease `release()` settles capacity, closes the descriptor, and clears that snapshot on every exit. Existing generation-aware helpers can classify `missing | superseded | same_generation` only while that original admission remains alive. Service-level recovery after the call returns is therefore too late: a fresh observation describes current B, not original A.

Fixture level: expanded. Repair intensity: high. Project profile: SHUD-Harness.

## Goals / Non-Goals

**Goals:**

- Settle restored exact A inside the original store admission after a post-mutation failure.
- Never delete or reject a current B merely because its JSON fields equal A.
- Preserve failure identity/order and release permit, FD, capacity, parent binding, and authority state exactly once.
- Keep legacy/default conditional-delete behavior and unchanged consumers compatible.

**Non-Goals:**

- PR #106 record-generation recovery policy and successor classification.
- Issue #107 record exact-replacement publication provenance/commit outcome.
- Generic retry loops, service-side `stat`/inode checks, persisted artifact shape changes, or `zero/` edits.

## Decisions

1. **Use an opt-in store-internal total operation, not an externally reusable retry token.** The post-mutation settlement runs before the original authority lease releases, while the store still owns A's snapshot and pinned descriptor. Exposing a token after return would require reversing the existing terminal permit lifecycle and lengthening caller-owned FD/capacity retention. The API remains opaque and additive; existing callers keep the current default.
2. **Retry only a post-mutation failure and at most once.** Normal `deleted`, `missing`, `superseded`, or `condition_not_met` results are terminal and never trigger a second observation/delete. Pre-mutation authority loss remains non-destructive and is not retried.
3. **Authorize settlement only from the original snapshot.** The store reuses the claimed permit's parent binding, physical identity, bytes, pathname epoch, and pinned descriptor. Exact A may be deleted; missing or any physical/content successor is convergence and remains untouched. Field/schema equality is never deletion authority.
4. **Use an explicit total-operation result algebra.** A recovered post-mutation failure returns `recovered { settlement: deleted | missing | superseded }` and does not fail a fulfilled service operation. If exact settlement or final authority release also fails, the original post-mutation error becomes primary and each distinct later failure is appended once in occurrence order. Missing/superseded settlement adds no failure of its own.
5. **Transition artifacts opt into the new mode at the shared delete roots present on `main`.** `releaseOwnedIdempotencyTransitionArtifact` and `consumeObservedIdempotencyTransitionArtifact` use the total operation; `recoverOwnedIdempotencyTransitionGuardAfterTerminalReleaseFailure` no longer performs fresh field-equality deletion. Older artifact JSON remains valid. PR #106-only helpers are handled by the rebase gate below, not implemented in this prerequisite branch.
6. **Use deterministic store hooks only if an existing hook cannot place B after restoration and before settlement.** Any new hook is optional test instrumentation, exposes no authority material, and does not change production behavior when absent.

### Total-operation result table

| Service body | Initial conditional delete | Exact failure settlement | Final authority release | Store/service result |
| --- | --- | --- | --- | --- |
| fulfilled or pending | `deleted | missing | superseded | condition_not_met` | not run | success | return the initial result unchanged |
| fulfilled or pending | pre-mutation throw | not run | success | throw the original pre-mutation error; existing service classification remains |
| fulfilled | post-mutation throw | `deleted | missing | superseded` | success | return `recovered` with that settlement; service release succeeds and preserves its fulfilled value |
| failed | post-mutation throw | `deleted | missing | superseded` | success | store returns `recovered`; outer service body error remains the only primary |
| any | post-mutation throw | throws | success | throw initial post-mutation error primary + settlement compensation |
| any | post-mutation throw | converges or throws | throws | throw initial post-mutation error primary, then settlement failure if present, then authority-release failure |

Identity dedup removes only repeated references to the same error object. A distinct failure with equal text is retained.

### Opt-in and default sibling table

| Boundary | Mode after #108 | Compatibility evidence |
| --- | --- | --- |
| `releaseOwnedIdempotencyTransitionArtifact` for owned guard and cleanup lock | opt-in total operation | public `completeRecord`, `failRecord`, retained/terminal guard tests |
| `consumeObservedIdempotencyTransitionArtifact` for stale, rollback, and recovery guards | opt-in total operation | public stale/recovery guard tests |
| `recoverOwnedIdempotencyTransitionGuardAfterTerminalReleaseFailure` | no fresh writable observation; classification/assertion only or removed | fulfilled guard and fail recovery tests |
| Generic `conditionalDeleteJsonRecordWithCleanupPermit` callers and writable-probe/store publication compensation | default unchanged | existing post-mutation restoration and generic record tests |
| TaskCard observed/published deletion, validation, publication-authority transfer, and exact-observation settlement | default unchanged | representative TaskCard observed/published cleanup tests |
| `zero/` submodule and backend HTTP routes | unchanged | zero diff; existing keyed route suite |

### Explicit regression matrix

| Initial artifact A and injection | Store/public seam | Required observable result |
| --- | --- | --- |
| A; initial delete succeeds; B installed only after completion | opt-in store API plus guard/cleanup-lock service release | initial `deleted`; no settlement call; fulfilled output; B bytes/dev/ino unchanged |
| A; pre-mutation replacement by different-field or same-field/new-inode B | guard/cleanup-lock release and observed guard consume | existing pre-mutation classification; B unchanged; no retry |
| A; post-mutation hook fails and compensation restores exact A | opt-in store API and public guard/cleanup-lock paths | `recovered/deleted`; fulfilled service output; A absent; initial marker not thrown |
| A; after restoration pathname becomes missing | same | `recovered/missing`; fulfilled output; resource baselines |
| A; after restoration different-field B or same-field/new-inode B is installed | same | `recovered/superseded`; fulfilled output; B exact bytes/dev/ino unchanged |
| A; exact settlement throws | opt-in store API | initial post-mutation marker primary; settlement marker one compensation |
| Body also fails and release/settlement fail | public service wrapper | body primary → initial release → settlement → final release, each distinct identity once |
| A remains exact but the caller predicate rejects it | default and opt-in store seams | exact `{ status: "condition_not_met" }`; no settlement; A bytes/dev/ino unchanged; permit terminal |
| Guard bytes are malformed JSON | `lookupReplay` and rollback recovery | `TaskServiceError { code: "record_malformed", status: 500, retryable: false }`; malformed bytes unchanged; durable record unchanged |
| Legacy identity-only guard `{ guard_id, owner_pid, acquired_at_ms, acquired_at }` accompanies a completed record | `lookupReplay({ scope, key, requestDigest })` | exact `{ status: "completed", record }`; legacy marker unchanged |
| Malformed guard is a two-link regular file or its pathname is a directory/special entry | `recoverCompletedRecordAfterRollbackFailure` | `TaskServiceError { code: "record_malformed", retryable: false }`; hardlink bytes/nlink or special entry unchanged; cleanup-lock absent; durable started record unchanged |
| Guard or cleanup-lock parent/pathname rebounds outside the admitted binding | release/consume seams | `TaskServiceError { code: "workspace_path_not_safe", status: 500 }`; rebound entry and external target unchanged; no foreign deletion |

### Concrete public compatibility rows

| Public call and precondition | Exact successful result that must remain stable | Exact failure/replay compatibility |
| --- | --- | --- |
| `completeRecord({ scope, key, requestDigest, resultRef })` with a matching `started` record | return the same-shape `IdempotencyRecord`: original `key/scope/request_digest/created_at`, `status: "completed"`, supplied `result_ref`, and `updated_at: now()`; guard and cleanup-lock absent | missing record → `TaskServiceError` `record_malformed/500`; digest mismatch → `idempotency_mismatch/422`; `lookupReplay` then returns `{ status: "completed", record }` |
| `failRecord({ scope, key, requestDigest })` with a matching `started` record | return the same-shape `IdempotencyRecord`: original `key/scope/request_digest/created_at`, `status: "failed"`, no `result_ref`, and `updated_at: now()`; guard and cleanup-lock absent | digest mismatch → `idempotency_mismatch/422`; `lookupReplay` returns `{ status: "incomplete", record: failedRecord }`; same-digest `beginRecord` may reacquire as before |
| `lookupReplay({ scope, key, requestDigest })` | missing → `{ status: "missing" }`; started/failed → `{ status: "incomplete", record }`; completed with safe `result_ref` → `{ status: "completed", record }`; digest mismatch → `{ status: "mismatch", record }` | malformed private guard → `record_malformed/500` and bytes preserved; exact stale fail-intent guard over a completed record → `{ status: "completed", record }` and guard absent; mismatched fail-intent guard → `record_malformed/409` and guard preserved |
| keyed task create route using one idempotency key/digest | first request remains HTTP `201`; exact replay remains HTTP `200` with the same task/result identity | same key with different digest remains typed `idempotency_mismatch` (HTTP `422`); this row is compatibility evidence only and does not authorize backend changes |

## Invariant Matrix

Governing invariant: only the original observed/published physical generation A may be deleted; post-failure settlement never derives authority from current pathname fields.

Source-of-truth identity/contract: the claimed cleanup permit snapshot—parent binding, generation dev/ino, expected bytes/mode/nlink, pathname epoch, and pinned descriptor—until one terminal store operation completes.

Surfaces:

- Producers: cleanup permits created by exact observation and owned artifact publication.
- Validators/preflight: cleanup-permit admission, parent/pathname binding proof, generation classification.
- Storage/query: generation-aware conditional delete and exact-observation settlement in `workspace-record-store.ts`.
- Public entrypoints: `createIdempotencyRecordService` guard/cleanup-lock release and stale/recovery paths.
- Downstream consumers: normal complete/fail/replay and keyed task idempotency remain unchanged.
- Failure/rollback/stale state: pre/post-mutation delete failure, restored A, missing, different-field B, same-field/new-inode B, retry failure, body/release failure.
- Evidence/readiness: exact bytes/dev/ino, replay, path absence/preservation, error graph, FD close count, permit/capacity/authority/binding diagnostics.

Regression rows:

- Post-mutation failure restores A → one internal settlement deletes exact A and returns a recovered result; fulfilled service output remains fulfilled.
- Before settlement, pathname becomes missing or B (different fields or same fields/new inode) → recovered convergence preserves B/missing and does not throw the original recovered failure.
- Initial delete succeeds → no second settlement; a later B is untouched and fulfilled service result remains fulfilled.
- Settlement or final authority release also fails → original post-mutation failure primary, later failures ordered exactly once, resources terminal.
- Default non-opted conditional delete and legacy artifacts → existing behavior unchanged.

## Boundary-Surface Checklist

- Shared roots: permit claim/release, generation classification/removal, compensation preservation.
- Read/write/delete: exact observation, owned publication permit, conditional delete, no fresh writable observation.
- Staging/rollback: canonical isolation restoration and post-mutation cleanup.
- Stale/idempotency: guard, cleanup lock, terminal recovery, rollback recovery.
- Unchanged consumers: generic record deletion, TaskCard/artifact deletion, backend routes, `zero/`.

## Risks / Trade-offs

- [Longer store admission during failure settlement] → one bounded attempt only; assert FD/capacity and timeout baselines.
- [Changing generic delete semantics] → explicit opt-in; keep existing default regression green.
- [Retry hook creates a second authority path] → hook is observation-only timing control; all authority stays in the original store snapshot.
- [Error graph duplication] → identity-dedupe only the same object; preserve distinct failures in occurrence order.

## Migration Plan

Additive implementation with no persisted-data migration. Rollback removes the opt-in call sites and store mode; default conditional-delete behavior remains available throughout.

After this prerequisite merges, PR #106 MUST rebase onto it and remove its branch-only `settleExactIdempotencyTransitionArtifact`, `settleAfterSiblingMutation`, and unconditional second settlement. PR #106 then consumes the shared store total-operation contract and reruns its existing review ledger without resetting the round counter.

## Open Questions

- None. If the original store admission cannot retain enough authority through canonical restoration, stop and report the blocker rather than falling back to service re-observation.
