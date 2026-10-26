## Why

#373's native R3 test can manufacture inconsistent wall-clock/kernel-uptime evidence. A controlled Linux1200ms delay after Date freezing yields lost classification despite a live wrapper, zero takeovers and the original empty-refusals failure. Real Date only across startup restores registration and all original assertions. Historical CI lacks diagnostics; exact historical interleaving is not recoverable.

Issue type: test
Fixture level: compact
Upstream suggested level: absent (test-only clock setup and failure diagnostics; no production contract change)
Blast radius: native recovery/cancellation test evidence and required CI reliability.
Selected risk packs: Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: controlled Linux red/green, injected failure-report proof, 20 whole-file consecutive passes per Linux/macOS, default check, CP4 white-box review and exact-head CI.

## What Changes

Keep the existing fake interval registry, but expose real Date during startup and only restore the already-installed fake Date immediately before public cancellation, capturing the cancellation origin then. Do not reinstall timers or discard the dispatcher interval. Restore the Date stub before existing real-timer cleanup even on failures. No design.md is required at compact level.

Attach complete harness errors, durable state and takeover registration count to failures of the R3/R5 shared test. Capture durable evidence before destructive fixture cleanup; distinguish the capture point and unavailable evidence rather than throwing from diagnostics. Report only on failure, preserving the original error, assertions and cleanup order. A cleanup failure must still have the retained pre-cleanup snapshot and final error list.

## Capabilities

### Modified Capabilities

- `engineering-gates`: coherent native recovery clocks and self-contained failure evidence.

## Impact

Only `packages/dsh-shud-jobs/src/takeover-shud-lifecycle.test.ts` and this fixture. Preserve every refusal/snapshot/MISMATCH/error assertion, public kill checks at9999/10000ms, signal sequence, done/result, immutable invocation and empty delivery assertions. No production process-birth/R3/R4 changes, dependency/CI changes, skips or retries. This does not claim scientific or PI acceptance.
