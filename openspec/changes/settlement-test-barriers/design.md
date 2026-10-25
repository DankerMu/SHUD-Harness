# Design

## Context and governing invariant

A manual tick can join an already accepted step that read old exit evidence and returned without settlement. Waiting for it is not a settlement receipt. Consumers must establish the actual prerequisite before dereferencing completion arrays or collecting.

## Decisions

Reuse `reconcile-shud/test-harness.ts` `waitForRecovery` (existing 5s deadline/10ms cadence), as the already-fixed sibling consumers do. Every iteration drives the existing registry `pollOnce`; no collect retry. Although these sites use real timers, using a different timer-only wait would drift from the issue's explicit per-iteration contract.

1. Published exit versus cancellation: preserve pre-release drain; after release drive/wait until `producer.completed.length === 1`, then retain all durable exit/cancel/parent outcome assertions.
2. Bad record isolation: after healthy release, each iteration drives poll and asserts bad bytes unchanged, bad completed empty and bad cancellation empty; return only when good completed length is one. Preserve the complete post-wait assertions and indexes/errors checks. Do not infer bad-entry completion from good-entry progress: entries advance independently.
3. Invalid exit bytes: after publication drive/wait for producer completed length one, then retain failed/null/detail/original bytes and rejected collect/ledger assertions.
4. Immediate native exit: `detachedProducer` has no completed array (issue example is incorrect). After exit bytes exist, drive/wait for validated RunJob status in `succeeded | failed | cancelled | collected`; do not use arbitrary non-running states (created/submitted are not collectible). Preserve expected exit classification, full collected record equality, native identity, invocation, logs, tmp absence and later public parent-status assertion.

## Must preserve and sibling surfaces

All protected sites enumerated in #352 remain byte-unchanged, including existing B/C repairs, external SIGKILL, pure-disk recovery, forced identity reread, and native reaping proofs. No shared harness changes. `shud-poll.ts`, all production files, cleanup quiescence and default cadence remain unchanged. A bounded wait must still fail if settlement never occurs; no swallowed exceptions or assertion retries.

## Evidence and risks

The existing real site-1 RED is the regression anchor; do not claim the other narrow windows were observed. Run all three files and full default check after changes. Read-only diff audit proves all four preconditions and protected scope. Native test execution is the changed surface; no new permanent tests of wiring or source text. CI provides Linux coverage; local native runs are Darwin. Prior full-suite failure remains retained even after a green run.

## Non-goals

No production queue repair, retry policy, timeout changes, unbounded waits, artificial sleeps, fake-timer configuration, new exported helper, #343/#344 policy changes, or PI acceptance. Rollback is reverting this test-only change; no data migration.
