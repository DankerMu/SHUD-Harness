# Tasks

## 1. Original-instance observation contract

- [x] 1.1 Add behavioral assertions before source changes: disk-only seeded duration and recovered R6/R3/R5/R8 generation are null; real original online direct/automatic collection remains nonnegative and exactly recomputable. Preserve unknown-endpoint and unwitnessed negative-duration rejection tests. Parent records the actual focused RED, distinguishing already-passing R2 controls.
- [x] 1.2 Carry copied original-start identity on the existing receipt and hand off only an actual successful, eligible terminal observation to the canonical collector. Migrate every internal caller; preserve failed/deferred terminal publication, completion retries, lost/invalid exit, identity/instant mismatch, collect retry/cap behavior, and existing timestamps/signals/notifications. Verify numeric withholding occurs only after existing interval validation and no test-only/public witness injection exists; contrast active-capped numeric retry with a late manual generation after completed-index pruning, which is null.
- [x] 1.3 Prove the persistence boundary with actual child processes and deterministic barriers: terminal published then crash before result commit yields null in another process; a genuinely generated original-instance numeric result remains byte/mtime-identical on cross-process re-collection, including failed collected projection. Extend existing native/child fixture patterns rather than inventing process identity or a parallel recovery implementation; verify owned cleanup.
- [x] 1.4 Synchronize current M2 design/RunRecord/collection semantics, Minimal_Schemas, Park_Resume_Design, affected instruction/project-profile wording with PI comments 6397950076/6405181313. Preserve historical checked tasks and archives; document observation-window precision limits, negative rejection and immutable historical records. Render instruction projections and post #293/#318 engineering-boundary notes without PI approval.

## 2. Canonical semantic projections

- [x] 2.1 Add a failing generator behavior check for nullable field semantics without changing enum/constraint/example behavior. Add canonical descriptions to the existing time fields and minimal optional Markdown semantic projection support, reading wrapper metadata before non-null fallback. Keep the existing five-column table and unannotated outputs unchanged; verify healthy formatting/escaping and nullable metadata preservation, not permanent pins to current prose.
- [x] 2.2 Run schema:generate and existing generator self-tests/drift gate; use a throwaway projection check to show current canonical wording reaches both JSON Schema and Markdown, and validation/schema shape, generated paths and unrelated projections remain unchanged. Update only relevant existing documentation; no generated hand edits or gate relaxation.

## 3. Integrated engineering delivery

- [x] 3.1 Parent runs focused duration/recovery/cross-process tests and native duration smoke, full pnpm run check, profile:smoke, actual shud:restart and strict validation of both changes. Preserve failed-before/passed-after evidence, clean owned temporary probes, and distinguish engineering proof from PI acceptance.
- [ ] 3.2 Complete expanded CP4/CP7 three-seat review, adjudication/fix gate and exact-head CI; merge/close #344 under the PI-adjusted observation-window criterion and archive only this change. Keep m2-run-chain/#293/#318 pending centralized PI acceptance.

## Risk packs and scope

- Selected: Public API / CLI / script entry — 1.1/1.3 actual submit/collect and cross-process consumers; 2.2 generation command; 3.1 actual host. Public collect signature/tool output shape unchanged.
- Selected: Concurrency / shared state / ordering — 1.2 original identity before receipt deletion, own terminal publication before observation handoff, per-entry retry and drain; 1.3 crash/commit boundaries. No process-global timing cache or duplicate eligibility index.
- Selected: Error handling / rollback / partial outputs — 1.1 negative interval remains loud even without observation; 1.2 failed publication/invalid evidence cannot mint confidence; 1.3 committed result outranks projection failure; retry ledger/controlled diagnostics unchanged.
- Selected: File IO / path safety / overwrite — 1.3 immutable record bytes/mtime and existing path/identity guards; 2.2 existing generated-path guards and no hand edits. No new persistent file or overwrite policy.
- Selected: Schema / columns / units / field names — 1.1 seconds and unknown/null semantics, unchanged identity timestamps; 2.1–2.2 canonical nullable descriptions and generated wording without schema shape changes. CP7 whitebox review in 3.2.
- Selected: Legacy compatibility / examples — 1.1 numeric online and unknown-time controls; 1.3 old committed records returned unchanged, not retroactively certified; 2.1 unannotated output/enum/example stability.
- Selected: Resource limits / large input / discovery — 1.2 minimal scalar snapshots, observation retention only for active work/retries, cleanup on committed result/index completion/drained disposal; no extra timers, OS probes, full-record copies or unbounded history.
- Selected: Documentation / migration notes — 1.4 actual PI clarification replaces the former upper-bound criterion; 2.2 canonical wording; no fabricated fixed precision or scientific runtime conclusion.
- Not selected: Config / project setup; Release / packaging / dependency compatibility; Auth / permissions / secrets — no configuration, dependency, package entrypoint, auth or credential flow changes. Existing raw/host/signal ownership boundaries remain covered by unchanged full/runtime gates.

Minimal mergeable slice: atomic evidence gating plus preserved negative/immutable behavior, actual cross-process proof and canonical generated semantics. Splitting the producer observation from collection or omitting nullable projection would leave a contradictory consumer-visible duration contract.
