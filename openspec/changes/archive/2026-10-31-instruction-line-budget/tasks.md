# Tasks

## 1. Budget gate and rule placement

- [x] 1.1 Added dependency-free real-render boundary self-tests; parent observed old checker wrongly accepting byte-matching 321/320 and 41/40 cases (two semantic failures, four tests, 0.248s), while 320 and CLAUDE-only excess controls passed.
- [x] 1.2 Added config-sourced AGENTS-only --check enforcement, CI/guardrail self-test wiring and constraints-bearing --root fixture; eight Python tests PASS, retaining both projections' drift checks.
- [x] 1.3 Parent rendered both roots: AGENTS 315, CLAUDE 312, shared 300; all 33 original enforcement table lines retained, mandatory references/PI-gate role authority preserved, all other shared sections and Runtime Lifecycle unchanged; threshold remains 320.

## 2. Verification and delivery

- [x] 2.1 Parent default pnpm docs:check fixture smoke passed AGENTS320, rejected321, and passed AGENTS320/CLAUDE717; guardrails170 PASS, full check146 files/4871 PASS/2 SKIP and strict validation PASS. Final authority wording was re-rendered and eight self-tests/docs/strict revalidated.
- [x] 2.2 Expanded correctness/evidence/invariant reviews CLEAN at 2441567d, no findings or fix passes; CI41239596372 all eight jobs SUCCESS and exact-head ordinary PR506 merge completed. Independently archived with one additive engineering-gates requirement; M3 PI/ADR/Epic state unchanged.

## Risk pack mapping

- Selected Public API / CLI / script entry: renderer --check/--root and default instructions/docs commands, actual boundary/drift tests (1.1–2.1).
- Selected Config / project setup: threshold from constraints, unchanged320, Python-only docs CI/noinstall, guardrail fixture support (1.2–2.1).
- Selected File IO / path safety / overwrite: canonical sources versus generated outputs, temporary fixture roots/cleanup, line count (1.1–2.1).
- Selected Error handling / rollback / partial outputs: clear missing/malformed budget failure, drift remains failure, no fallback (1.2).
- Selected Documentation / migration notes: mandatory relocated rules and role mapping, full inventory, no effective-rule loss (1.3).
- Not selected Schema / columns / units / field names: no runtime schema or threshold-key change.
- Not selected Auth / permissions / secrets: governance authority preserved, no access/runtime policy change; PI rules covered by rule inventory.
- Not selected Concurrency / shared state / ordering: no runtime scheduler/CI concurrency policy changes, isolated fixtures only.
- Not selected Resource limits / large input / discovery: existing fixed file line budget, no new discovery; budget belongs to selected Config/CLI.
- Not selected Legacy compatibility / examples: existing command compatibility covered under CLI, no shims.
- Not selected Release / packaging / dependency compatibility: no dependencies/build artifact package changes; existing Python prerequisite.
