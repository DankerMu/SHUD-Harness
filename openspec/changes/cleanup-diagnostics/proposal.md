# Proposal

## Why

Issue #349's captured reproduction was traced to overly broad startup fault injection, already narrowed in PR #351. The remaining obligations are diagnostic: default Vitest output loses nested cleanup causes, and finally failures can hide the body/pending rejection. Earlier untraced failures remain unexplained; this change must not label them fixed flakes.

## What Changes

- Add one test-only diagnostic owner for nested errors/causes and failure-time native pid/pgid/state snapshots, reused by detached, submission and polling harness cleanup surfaces.
- Keep original error objects available while making all captured inner messages/stacks visible under the existing default reporter.
- Retain body/pending rejection alongside cleanup failure without changing cleanup order, quiescence gates, timeouts, shared fixture defaults or production ownership proofs.
- Add diagnostic fault-injection regressions and actual default-reporter RED/GREEN proof; document the bounded historical causality claim.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `engineering-gates`: add cleanup failure diagnosability and primary-error preservation requirement.

## Impact

Test-only diagnostics/helper and detached/submission/poll harnesses, targeted fault test and focused tests, existing testing documentation. No production abort/group/process/submission code, reporter configuration, dependencies or fixture default changes.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for native process diagnostic boundary and shared lifecycle test infrastructure.
Blast radius: default test/CI failure output and fixture error propagation, not product lifecycle.
Selected risk packs: Public API / CLI / script entry; Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Resource limits / large input / discovery; Documentation / migration notes; Scientific governance / PI gate / evidence lineage.
Evidence floor: before/after default reporter fault injection, permanent captured-error/primary-error regressions, native snapshot/no-secret command proof, focused lifecycle tests, full check and exact-head CI/review.
