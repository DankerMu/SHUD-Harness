## Why

Phase 1 should not exit on feature completion alone; it needs repeatable checks that prove schema, API, UI shell, docs, and health endpoints are coherent. A final quality-gate changeset prevents partial skeletons from being treated as phase-complete.

## What Changes

- Add root verification scripts for typecheck, unit tests, integration tests, UI smoke tests, docs link smoke, and requirements ID uniqueness.
- Add `/api/health/live` and `/api/health/ready` smoke behavior.
- Add structured API log smoke validation.
- Add Phase 1 exit checklist documentation in OpenSpec tasks.
- Add CI-ready command grouping, even if CI wiring itself remains minimal.

## Capabilities

### New Capabilities

- `phase1-quality-gates`: Defines the verification gates required to exit Phase 1.

### Modified Capabilities

None.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/Phased_Spec_Activation.md` | Normative Phase 1 exit criteria: schema, API, UI smoke, and docs link checks. | Does not include Phase 2 dummy job/WebSocket gates. |
| `docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md` | Normative readiness and deterministic skeleton verification gates. | Readiness items already satisfied by docs/submodules should be checked, not reimplemented. |
| `docs/04_IMPLEMENTATION/Testing_Strategy.md` | Normative test layering and Phase 1 test categories. | Real ccw tiny fixture tests are Phase 3+ and out of scope. |
| `docs/04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md` | Normative detailed Phase 1 test IDs and pass criteria. | Only Phase 1 tests are implemented in this changeset. |
| `docs/04_IMPLEMENTATION/Performance_Test_Plan.md` | Phase 1 subset reference for API metadata performance smoke expectations. | No SHUD runtime or batch performance tests. |
| `docs/04_IMPLEMENTATION/Observability_Test_Plan.md` | Phase 1 subset reference for health and structured-log smoke expectations. | No alerting dashboard, job monitoring, or operational drill requirements. |
| `docs/00_INDEX/Requirements_Catalog.md` and `docs/00_INDEX/Requirements_Numbering_Conventions.md` | Normative requirement ID uniqueness and traceability rules. | Checks are limited to catalog consistency; no full coverage matrix enforcement yet. |

## Impact

- Affected paths: root scripts, backend health routes, tests, docs check scripts.
- Depends on all other Phase 1 changesets.
- Establishes exit criteria for moving to Phase 2 execution-loop work.
