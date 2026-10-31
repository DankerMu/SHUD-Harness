# Tasks

## 1. Emitted package boundary

- [x] 1.1 Added real external-cwd package-boundary regression using copied emitted records and explicit core dependency; parent fresh-build run observed Node ERR_MODULE_NOT_FOUND for the absent ancestor package.json during module linking (1 semantic RED) before source/build changes.
- [x] 1.2 Generated package-local canonical version before tsc, removed runtime root import, and documented build/relocation contract; same regression plus existing capture tests GREEN (56 PASS), with API/schema/dependencies/files list unchanged.

## 2. Integration and delivery

- [x] 2.1 Parent verified clean/repeated build and isolated canonical version refresh with the unchanged generator bytes; final scripts/records placement passed full check (146 files, 4871 PASS, 2 SKIP), strict validation, external public-entry capture/readback/reuse smoke and profile smoke.
- [x] 2.2 Expanded three-seat review CLEAN on a4606175, CI 41235587328 all green, PR #504 merged as db600533; independent archive synced one additive stack-lock requirement without M3 PI/ADR/Epic changes.

## Risk pack mapping

- Selected Public API / CLI / script entry: emitted public import/capture and unchanged caller contracts (1.1–2.1).
- Selected Config / project setup: generation-before-tsc, clean/repeated build and documented test prerequisite (1.2–2.1).
- Selected File IO / path safety / overwrite: only generated lib artifact; physically copied package, independent cwd, owned scratch cleanup (1.1–2.1).
- Selected Release / packaging / dependency compatibility: existing exports/files and explicit core runtime dependency; external Node link (1.1–2.1).
- Selected Documentation / migration notes: existing Repository_Layout note; rebuild only, no data migration (1.2).
- Not selected Schema / columns / units / field names: no shape/field/version semantics changed; existing capture schema tests preserved.
- Not selected Auth / permissions / secrets: version-only generated data, no new credential handling.
- Not selected Concurrency / shared state / ordering: no runtime concurrency; build-first ordering under Config, no test-side shared rebuild.
- Not selected Resource limits / large input / discovery: fixed manifest/version input, no new scanning.
- Not selected Legacy compatibility / examples: unchanged capture signatures/consumers covered under Public API; no compatibility shim.
- Not selected Error handling / rollback / partial outputs: no runtime error-path changes; failed generation/compile remains failed build, no fallback; owned temporary cleanup under File IO.
