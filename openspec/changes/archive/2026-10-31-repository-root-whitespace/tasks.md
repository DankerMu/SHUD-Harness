# Tasks

## 1. Root pathname fidelity

- [x] 1.1 Add real committed trailing-space/LF root regression in existing tests; parent observed both semantic non-root failures before source changes (2 RED, 48 PASS, 1 SKIP), retaining existing descendant rejection control.
- [x] 1.2 Strip only one top-level LF; update Minimal_Schemas documentation; focused tests GREEN (50 PASS, 1 SKIP) with old four-argv, locator/environment/index/ancestor contracts unchanged.

## 2. Integration and delivery

- [x] 2.1 Parent ran built public-entry real-git smoke (space/LF clean, dirty, descendant rejection and index bytes all PASS), full pnpm run check (145 files, 4870 PASS, 2 SKIP) and strict OpenSpec validation; evidence and limits published in PR.
- [x] 2.2 Expanded three-seat review CLEAN on aa86833a, CI 41225771118 all green, PR #499 merged as f162a614; independent archive synced one additive stack-lock requirement, without closing/archiving M3 PI work.

## Risk pack mapping

- Selected Public API / CLI / script entry: unchanged export/signature, real collector tests and built public-entry smoke (1.1–2.1).
- Selected File IO / path safety / overwrite: whitespace fidelity plus descendant refusal; existing index-readonly evidence (1.1–2.1).
- Selected Error handling / rollback / partial outputs: retain non-root and git failure behavior, focused existing cases (1.2).
- Selected Documentation / migration notes: Minimal_Schemas and this additive contract; no data migration (1.2, 2.2).
- Not selected Config / project setup: no config/default changes.
- Not selected Schema / columns / units / field names: no schema, field or fingerprint changes.
- Not selected Auth / permissions / secrets: no permission/secret boundary changes; preserve existing isolated git environment.
- Not selected Concurrency / shared state / ordering: synchronous string framing only; no lifecycle changes.
- Not selected Resource limits / large input / discovery: no new discovery/limits; old status overflow behavior unchanged.
- Not selected Legacy compatibility / examples: public API unchanged; whitespace repair is covered under Public API, no migration or compatibility shim.
- Not selected Release / packaging / dependency compatibility: no dependency/export/layout changes; normal existing build only.
