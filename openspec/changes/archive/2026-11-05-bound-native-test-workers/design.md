# Design

## Context

The original default-check failure is retained in `.workplans/issue-623/full-check.log`: the candidate evidence case took 5905 ms and hit the existing 5000 ms deadline. Isolated execution passed; full-context traces and bounded independent lanes exposed load-sensitive latency in real fixture creation, building and first native execution. All 21 eight-lane timeout cases eventually returned the build and operation callback, but final preservation was not established for those failed tests.

The instrumented full suite with default 13 workers had six native/Git failures; changing only maxWorkers to four produced 246 passing files / 8555 passing tests / two existing skips, with the target at 3135 ms. Four-lane calibration is not identical to a full-suite schedule. The specific OS resource/mechanism and the exact phase split of the historical 5905 ms failure remain unknown.

## Goals / Non-Goals

- Bound normal file-level scheduling to a measured conservative budget while retaining the same consumer checks and 5000 ms deadline.
- Do not change direct kernel/shebang execution into explicit script interpretation: those paths have observably different first-launch costs and are not equivalent proof.
- Do not edit tests, fixture factories, production build code, cleanup, clocks, retries, test discovery, coverage or dependency versions.
- Do not promise success under arbitrary external load or several concurrent test-runner instances. Explicit diagnostic CLI overrides are not the default gate.

## Decisions

1. Add `thresholds.test_file_workers_max: 4` as the canonical resource ceiling. Mirror the number with a pointer comment in vitest.config.ts, following the repository's existing YAML/config mirror convention; no new parser or dependency.
2. Resolve default workers as `min(4, max(1, availableParallelism() - 1))` using Node's public API. Four is a ceiling, not a requirement to oversubscribe a small CI host; one worker remains available on a one-CPU host.
3. Preserve the original pool, test/hook deadlines, coverage and every other runner setting. This changes independent test-file scheduling only; concurrency inside a test, including simultaneous-publication checks, remains exercised.
4. Keep the resource rationale in Testing_Strategy and public PR evidence. Do not add permanent tests that merely pin this configuration literal or copy documentation; use a throwaway resolved-configuration/boundary probe and the existing behavioral suite.

## Verification and Sibling Surfaces

Before implementation, retain original/default and controlled-load RED evidence, the alias-induced invalid diagnostic trial separately, four-lane controls, and the full-suite four-worker counterfactual. Parent then verifies mirrored configuration, CPU-count boundaries, unchanged test/runtime hashes, the original default command, full test count/coverage, docs/schema/strict checks and exact-head CI. Review all independent native/Git fixture consumers through the full suite rather than weakening one slow case.

## Risks / Trade-offs

- Lower file concurrency can change throughput; the observed counterfactual took 203.38 s versus 195.87 s for the failed instrumented default run. This is scheduling evidence, not a performance guarantee.
- Timing failures from other causes or external load remain possible; retain failures and diagnose them, never add retries or label a later green run proof that every intermittent failure is gone.
- The explicit ceiling and leave-one-CPU rule must remain consistent with their documented purpose; no changed coverage/timeout/skip may accompany the fix.

## Migration Plan

Apply the three-file resource/config/documentation change, run the existing gates, review and merge. Revert those changes normally to restore the prior default; no persisted runtime state, migration or compatibility shim exists. Archive this independent engineering change after delivery, without archiving M4 or declaring PI acceptance.
