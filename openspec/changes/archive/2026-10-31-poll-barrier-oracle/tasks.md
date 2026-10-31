# Tasks

## 1. Diagnosis and canonical test

- [x] 1.1 Parent executed bounded instrumented control, controlled old-tail semantic RED, and same-tail-drain GREEN counterfactual; both metadata gates, healthy progress, single-flight and exact writes observed with clean native cleanup. Record historical attribution as unknown.
- [x] 1.2 Updated only the existing lifecycle scenario to establish fresh timer work and prove both held metadata boundaries, manual joins, healthy progress and exact writes; bounded failure evidence and Testing_Strategy updated. Canonical lifecycle 8 PASS; sibling poll tests 40 PASS; disposable omitted-publication-gate control failed at publication phase with terminalWrites=1 and retained original barrier cause, then removed.

## 2. Verification and delivery

- [x] 2.1 Parent ran lifecycle/sibling tests (8/40 PASS), profile smoke, full pnpm run check (145 files, 4870 PASS, 2 SKIP) and strict fixture validation; published controlled RED, counterfactual GREEN, negative publication control and historical limits.
- [x] 2.2 Expanded three-seat review CLEAN on b92c9432, CI 41231522754 all green, PR #501 merged as 069e5a74; independent archive synced the native settlement test requirement, without changing M3 PI/ADR/Epic state.

## Risk pack mapping

- Selected File IO / path safety / overwrite: real metadata/read/publication and both held gates; no filesystem behavior change (1.1–2.1).
- Selected Concurrency / shared state / ordering: explicit accepted timer/manual work, single-flight and independent run progress (1.1–2.1).
- Selected Error handling / rollback / partial outputs: primary failure evidence before cleanup, releases on failure, negative gate control (1.2–2.1).
- Selected Documentation / migration notes: Testing_Strategy and bounded historical attribution, no runtime migration (1.2).
- Not selected Public API / CLI / script entry: no signature or public entry change; profile smoke checks unchanged integration.
- Not selected Config / project setup: existing test-local interval control only; no production/shared defaults.
- Not selected Schema / columns / units / field names: no record/schema changes.
- Not selected Auth / permissions / secrets: no authority/credential changes; controlled fixture diagnostics only.
- Not selected Resource limits / large input / discovery: no production discovery/limits; diagnostics bounded under error handling.
- Not selected Legacy compatibility / examples: production unchanged, prior test assertions preserved; no compatibility shim.
- Not selected Release / packaging / dependency compatibility: no build/export/dependency changes.
