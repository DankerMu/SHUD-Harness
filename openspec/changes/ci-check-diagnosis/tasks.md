# Tasks

## 1. Diagnostic surface and invariants

- [x] 1.1 Added allowlisted aggregate metadata and existing-doc inspection/recovery guidance; parent shell smoke preserved command-like ref data without execution, and actual aggregate passed all-success plus 21 per-dependency failure/cancelled/skipped rejection controls.
- [x] 1.2 Parent full check, 170 guardrail self-proofs and strict fixture validation PASS. Frozen comparison confirmed workflow outside metadata and aggregate unchanged; authority snapshot retains one required context and empty rulesets/branch rules. No runtime or generated-root changes.

## 2. Hosted diagnosis and delivery

- [ ] 2.1 In an isolated PR, record same-head opened/labeled overlap with actual actions, run attempts, all seven results, suite/aggregate IDs, raw/required checks and merge state. Preserve original PR477 baseline and controls; distinguish any manual cancellation injection. Obtain a discriminating BLOCKED/required-PASS observation or report a real blocker rather than invent cause.
- [ ] 2.2 Recover by rerunning the affected suite's entire graph without changing SHA/policy; publish evidence-backed diagnosis and upstream report where service-side behavior is observed, with auditable recovery/limits in existing documentation. Verify all seven jobs and aggregate pass, required state matches and ordinary merge succeeds.
- [ ] 2.3 Complete expanded review and exact-head CI, ordinary merge/issue closure and independent archive; no M3 PI/ADR/Epic closure.

## Risk pack mapping

- Selected CLI/script entry: quoted fixed-format shell smoke and actual hosted logs (1.1,2.1).
- Selected Config/project setup: unchanged graph, triggers/concurrency/permissions; full gate (1.2).
- Selected Auth/permissions/secrets: allowlisted public fields, no payload/token, authority snapshots and no admin/policy bypass (1.1–2.2).
- Selected Concurrency/shared state/ordering: isolated event overlap, attempts/suites/checks, natural/control/manual distinction and unchanged-head recovery (2.1–2.2).
- Selected Error handling/partial outputs: cancelled/failure/skipped stay failed; missing historical action stays unknown; unresolved recovery escalates (1.1,2.1–2.2).
- Selected Documentation/migration: existing Testing_Strategy records exact commands, evidence, limits and public upstream report (1.1,2.2).
- Not selected File IO/path safety/overwrite: no new production file writer or path behavior; local evidence follows existing contract.
- Not selected Schema/columns/units: no runtime schema or API change.
- Not selected Resource limits/discovery: no discovery or new scheduler; full existing CI cost remains explicit.
- Not selected Legacy compatibility/examples: no migration or parallel implementation.
- Not selected Release/packaging/dependencies: no dependency/build/release change.
