# Tasks

## 1. Diagnostic and fixture gate

- [x] 1.1 Preserve the original #623 default-check RED and obtain stage evidence without changing tests/deadlines: four-lane 12/12 controls, eight-lane 21/24 original-target timeouts, and full-suite four-worker counterfactual; distinguish invalid diagnostic setup failures and unknown OS mechanisms.
- [x] 1.2 Obtain read-only expanded fixture review and strict OpenSpec validation before implementation; publish the evidence-backed issue boundary without changing the original timeout or evidence oracle.

## 2. Default resource bound

- [x] 2.1 Add the canonical ceiling and matching CPU-aware default worker setting, document the resource boundary in Testing_Strategy, and verify actual resolved CPU cases 1/2/4/14/64 with a throwaway probe; retain byte-identical test/runtime sources and all other runner/constraint settings.
- [ ] 2.2 Run the original `pnpm run check` with no worker override, verify all 8555 current tests plus only the two existing skips, original candidate/native assertions and coverage floor, schema/docs/strict checks; perform expanded review and exact-head eight-job CI before merge.

## Risk mapping

- Config/setup, concurrency/shared resources, resource limits: selected; 2.1 resolved default/CPU boundary probe and 2.2 complete suite/CI; within-test concurrency is unchanged.
- Compatibility/release: selected; existing native/Git consumers and direct executable invocation remain byte-identical, no dependency/CI job changes; verify through 2.1 hashes and 2.2 gates.
- Documentation: selected; Testing_Strategy records ceiling, scope and limits; 2.1 docs update, 2.2 docs check.
- Public runtime API, file publication/path safety, schemas/units, authorization/secrets, runtime errors/rollback: not selected for modification; production code, fixtures and scientific/PI contracts are explicit non-goals, not weakened to fix test timing.
