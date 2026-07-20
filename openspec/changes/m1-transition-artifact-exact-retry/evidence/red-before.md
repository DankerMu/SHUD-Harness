# Red-before evidence

The behavior red was run in the issue worktree with only the two production source files stashed:

- `packages/core/src/domain/services/workspace-record-store.ts`
- `packages/core/src/domain/services/idempotency-service.ts`

Tests and the delayed-watcher evidence remained present. The focused core command failed at collection because `conditionalDeleteJsonRecordWithCleanupPermitAndExactFailureSettlement` was not exported by the pre-change source. The delayed-watcher command failed because the same operation was undefined. The source stash was popped immediately after the batched red run.

No `red-proof` stash remains. An earlier syntax-invalid attempt was also popped immediately and is not used as evidence; the collection/undefined-symbol run above is the valid behavior red.
