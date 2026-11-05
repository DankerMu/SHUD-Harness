# Proposal

## Triage

- Issue: #624; type: test; fixture level: expanded; upstream level absent.
- Reason: the default test-runner entrypoint and file-level resource scheduling affect the full suite, although production code and test assertions remain unchanged.
- Blast radius: local/CI test throughput and deadline reliability, not SHUD behavior or PI authority.
- Selected risk packs: config/setup; concurrency/shared resources; resource limits; compatibility; documentation/release verification.
- Evidence floor: retained original RED, calibrated contention traces, unchanged-test full-suite counterfactual, resolved default worker budget, default check and exact-head CI.

## Why

The unchanged candidate-evidence test exceeded its 5000 ms deadline during #623. Controlled executions retained the original native launch and assertions: four lanes passed 12/12, eight lanes timed out 21/24; the default runner resolved to 13 workers on this 14-CPU host. The full instrumented suite passed all 8555 tests with only file-worker concurrency bounded to four. This supports a default resource bound, not a claim to have diagnosed an OS subsystem or eliminated all timing failures.

## What Changes

- Add a canonical default test-file worker ceiling of four in constraints.yaml and mirror it in the existing Vitest configuration convention.
- Keep at least one worker and leave one available CPU for orchestration/native children on smaller hosts; effective workers are min(4, max(1, availableParallelism - 1)).
- Document the scheduling boundary and evidence limits in Testing_Strategy. Preserve every test, native executable invocation, deadline, coverage floor, isolation rule, and per-test concurrency scenario.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `engineering-gates`: default test execution has a bounded file-worker budget without reducing the gate's behavioral coverage.

## Impact

Only vitest.config.ts, constraints.yaml, Testing_Strategy and this fixture change. No test/fixture, production package, dependency, runtime profile, CI job, scientific parameter or M4 PI-acceptance change. The configuration is reversible; this design records the resource decision without a separate architecture ADR or gate relaxation. #623 remains independently preserved until its default gate can complete; #549 remains PI-only.
