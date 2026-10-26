## Risk packs

- Selected: Concurrency / shared state / ordering — wait for notification presentation without changing any recovery, cancellation or pre-readiness assertion; tasks 1.1–1.3.
- Selected: Documentation / migration notes — fixture and published evidence explain the platform/CI causality boundary; task 1.4.
- Not selected: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Auth / permissions / secrets; Resource limits / large input / discovery; Legacy compatibility / examples; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility — production contracts, file operations, fixture cleanup, dependencies and CI are unchanged. Existing process/file assertions must remain exact.

## 1. Shared notification boundary

- [x] 1.1 Temporarily inject real post-readiness delay of at least 7ms before the old shared assertion; execute it on Linux and retain RED with null-versus-waiting detail mismatch. This is controlled mechanism evidence, not a rerun to confirm the reported CI failure.
- [x] 1.2 Reuse the existing bounded semantic `expect.poll` waiting-session pattern, then compare the collected snapshot with original notification fields except the observed detail. With the same delay, prove GREEN. Remove instrumentation before permanent verification. Preserve every other assertion and all production bytes.
- [ ] 1.3 Run the entire teardown file at least 20 consecutive times on Linux and 20 on macOS without retries/skips or proof delays; all must pass. Run `pnpm run check` and exact-head CI. Record actual platform/runtime and commands.
- [ ] 1.4 Publish evidence and limits: original CI observation is Linux, the changed block is shared with Darwin; packages/scripts were identical between PR #390 and #392. One read-only correctness+test-evidence review verifies cancellation sequences, original grace deadline, completions, durable snapshots, cancelled/null result, empty registry/session events/flushes and R7 warning remain unchanged. No PI acceptance is claimed.
