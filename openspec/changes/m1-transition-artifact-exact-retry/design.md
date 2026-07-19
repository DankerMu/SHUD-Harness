## Context

`WorkspaceRecordCleanupPermit` retains the observed physical generation, bytes, mode, link count, and pinned descriptor while outstanding. The conditional-delete path already moves public A into a random store-owned `0700` namespace before destructive work. The superseded repair restored A to the public pathname, watched the ancestor chain, and isolated A a second time. Delayed-callback diagnosis proved watcher delivery cannot authorize pathname-history claims. Error-occurrence diagnosis also proved that cloning/pruning raw `cause/errors/semanticPrimary` graphs loses identity and subtype while module-lifetime observation caches make independent folds stale.

Fixture level: expanded. Repair intensity: high. Project profile: SHUD-Harness.

## Goals / Non-Goals

**Goals:**

- Retain and settle the first privately isolated exact A inside the original store admission after a post-isolation failure.
- Treat the public pathname as observation-only after ticket capture; never restore A or delete/reject current B.
- Preserve immutable raw evidence separately from exact phase-tagged failure occurrences and typed transport views.
- Release permit, FD, capacity, mutex, bindings, private generation, and namespace exactly once.
- Keep legacy/default conditional-delete behavior and unchanged consumers compatible.

**Non-Goals:**

- PR #106 record-generation recovery policy and successor classification.
- Issue #107 record exact-replacement publication provenance/commit outcome.
- Generic retry loops, service-side `stat`/inode checks, persisted artifact shape changes, raw graph rewriting, native dirfd-relative unlink, or `zero/` edits.

## Decisions

1. **Capture a private one-consumer ticket at the first isolation.** The ticket is store-private and couples the owned namespace/generation expectation with the still-pinned permit. Its phase is monotonic and repeated settlement/release shares the same promise. Existing callers keep the default restore policy; only the total operation requests ticket handoff.
2. **Never reconstruct public pathname continuity after ticket capture.** Post-isolation settlement proves and removes only the private generation. Missing or any B at the public pathname is preserved and does not change the successful recovered/deleted result. Watchers, fixed waits, public restore, and public re-isolation are absent from the opt-in chain.
3. **Fail closed on private drift.** Private missing is successful only after the ticket has already proved removal and the pinned descriptor reports `nlink=0`. Foreign replacement, namespace drift, unexpected link count, permanent unlink failure, cleanup failure, or close failure are typed failures; none may become benign missing/superseded.
4. **Separate occurrence semantics from evidence graphs.** Each operation captures immutable phase-tagged occurrences. A fresh fold-local observation session records identity-unique nodes plus alias/edge metadata without rewriting caller objects. Event multiplicity and edge multiplicity remain distinct. Object occurrences deduplicate by identity in the ordered distinct view; primitive occurrences retain their tokens.
5. **Preserve exact roots and trusted typed views.** An `Error` primary is returned by exact identity and receives a private sidecar ledger. A non-Error primary uses an internal carrier whose ledger retains the exact value. `TaskServiceError` compatibility derives only from exact trusted ledger provenance; caller-created envelopes remain semantic roots unless a store-owned occurrence ref explicitly adopts an inner value.
6. **Migrate the naturally affected chain as one model.** Workspace settlement, idempotency/task-card adapters, and backend typed serialization use the same ledger accessors. Raw graph traversal remains only for JavaScript compatibility evidence. Older artifact JSON and public HTTP behavior remain unchanged.

### Total-operation result table

| Service body | Initial conditional delete | Exact failure settlement | Final authority release | Store/service result |
| --- | --- | --- | --- | --- |
| fulfilled or pending | `deleted | missing | superseded | condition_not_met` | not run | success | return the initial result unchanged |
| fulfilled or pending | pre-mutation throw | not run | success | throw the original pre-mutation error; existing service classification remains |
| fulfilled | post-isolation throw with private ticket | private `deleted` | success | return `recovered/deleted`; service release succeeds and preserves its fulfilled value and public missing/B |
| failed | post-isolation throw with private ticket | private `deleted` | success | store returns `recovered/deleted`; outer service body failure remains the only primary |
| any | post-mutation throw | throws | success | throw initial post-mutation error primary + settlement compensation |
| any | post-mutation throw | converges or throws | throws | throw initial post-mutation error primary, then settlement failure if present, then authority-release failure |

The ordered distinct ledger view deduplicates repeated object occurrences by identity. Distinct equal-looking objects and repeated primitive event slots remain. Raw aliases and repeated edges are retained unchanged and are not occurrence counts.

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
| A; post-isolation hook fails after first private proof | opt-in store API and public guard/cleanup-lock paths | private A deleted once; `recovered/deleted`; no public restore or second isolation |
| A; public pathname remains missing after isolation | same | `recovered/deleted`; public pathname remains missing; resource baselines |
| A; different-field B or same-field/new-inode B appears publicly after isolation | same | `recovered/deleted`; B exact bytes/dev/ino unchanged |
| A; ancestor ABA or delayed watcher callbacks after isolation | same | `recovered/deleted`; zero watcher registration and no event wait |
| private A missing with pinned `nlink>0`, replaced, or link-count drift | private ticket settlement | typed failure; public state untouched; no false recovered result |
| private unlink/namespace cleanup/close fails | private ticket settlement | monotonic phase; ordered ledger compensation; each resource settles once |
| A; exact settlement throws | opt-in store API | initial post-mutation marker primary; settlement marker one compensation |
| Body also fails and release/settlement fail | public service wrapper | body primary → initial release → settlement → final release ledger occurrences; unique object identities once in ordered view |
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

Source-of-truth identity/contract: after first rename and exact private proof, the claimed cleanup permit plus private ticket—owned namespace, private generation dev/ino/bytes/mode/nlink, and pinned descriptor—until one terminal store operation completes.

Surfaces:

- Producers: cleanup permits created by exact observation and owned artifact publication.
- Validators/preflight: cleanup-permit admission, parent/pathname binding proof, generation classification.
- Storage/query: generation-aware conditional delete and exact-observation settlement in `workspace-record-store.ts`.
- Public entrypoints: `createIdempotencyRecordService` guard/cleanup-lock release and stale/recovery paths.
- Downstream consumers: normal complete/fail/replay and keyed task idempotency remain unchanged.
- Failure/rollback/stale state: pre/post-mutation delete failure, first-private-isolation ticket handoff, public missing/B, private drift, body/settlement/release failure.
- Evidence/readiness: exact bytes/dev/ino, replay, path absence/preservation, occurrence ledger plus raw graph edges, FD close count, permit/capacity/authority/binding diagnostics.

Regression rows:

- Post-isolation failure hands off the first private A → one internal settlement deletes only that A and returns recovered/deleted; fulfilled service output remains fulfilled.
- Before settlement, the public pathname is missing or B (different fields or same fields/new inode) → private settlement still reports recovered/deleted and preserves that public state.
- Initial delete succeeds → no second settlement; a later B is untouched and fulfilled service result remains fulfilled.
- Settlement or final authority release also fails → original post-mutation failure primary, later failures ordered exactly once, resources terminal.
- Default non-opted conditional delete and legacy artifacts → existing behavior unchanged.

## Boundary-Surface Checklist

- Shared roots: permit claim/release, generation classification/removal, compensation preservation.
- Read/write/delete: exact observation, owned publication permit, conditional delete, no fresh writable observation.
- Staging/rollback: default-call canonical restoration; opt-in first-private-isolation handoff and post-mutation cleanup.
- Stale/idempotency: guard, cleanup lock, terminal recovery, rollback recovery.
- Unchanged consumers: generic record deletion, TaskCard/artifact deletion, backend routes, `zero/`.

## Risks / Trade-offs

- [Longer store admission during failure settlement] → monotonic ticket settlement with bounded private unlink/namespace cleanup attempts; assert FD/capacity and timeout baselines.
- [Changing generic delete semantics] → explicit opt-in; keep existing default regression green.
- [Node pathname unlink has a final proof-to-syscall window] → document that same-UID adversarial replacement needs a native dirfd-relative primitive and is outside this issue.
- [Failure aliases conflict with event counts] → immutable ledger exposes node, edge, event, and ordered-distinct views separately.

## Migration Plan

Additive implementation with no persisted-data migration. Rollback removes the opt-in call sites and store mode; default conditional-delete behavior remains available throughout.

After this prerequisite merges, PR #106 MUST rebase onto it and remove its branch-only `settleExactIdempotencyTransitionArtifact`, `settleAfterSiblingMutation`, and unconditional second settlement. PR #106 then consumes the shared store total-operation contract and reruns its existing review ledger without resetting the round counter.

## Open Questions

- None. The opt-in chain retains private authority at first isolation and must never fall back to canonical restoration or service re-observation.
