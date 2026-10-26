## Why

#393 pins submission-time notification detail after normal cadence has started. A legal waiting-for-session update therefore fails the shared Linux R8 / Darwin R7 teardown assertion. The observed CI failure is Linux; shared exposure does not establish an observed Darwin failure. PR #390 and #392 have identical packages/scripts, so the docs archive did not introduce it.

Issue type: test
Fixture level: none
Upstream suggested level: absent (isolated test-expectation update; no runtime changes)
Blast radius: the required test gate and cancellation evidence, not production behavior.
Selected risk packs: Concurrency / shared state / ordering; Documentation / migration notes.
Evidence floor: controlled delayed red/green; 20 consecutive whole-file runs on each native Linux/macOS platform; default check; exact-head CI.

## What Changes

Reuse the existing bounded semantic waiting-state poll before comparing the collected snapshot. Preserve all other assertions. Although fixture level is none, Critical Path 4 requires one correctness+test-evidence white-box reviewer. No design.md is needed for this isolated oracle update.

## Capabilities

### Modified Capabilities

- `engineering-gates`: extend the existing native completion prerequisite requirement to post-readiness notification presentation.

## Impact

Only the shared post-readiness assertion in `packages/dsh-shud-jobs/src/teardown-shud.test.ts` changes. No production code, CI, cadence, timer mocking, retries, skips or dependencies change. This fixture documents the test boundary; it does not claim scientific or PI acceptance.
