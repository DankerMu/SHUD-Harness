# Tasks

## 1. Resolved configuration precondition

- [x] 1.1 All three missing/zero/fractional direct-construction cases fail against old code because it accepted them, with safe cleanup and no timeout. Semantic RED retained; existing assertions unchanged.
- [x] 1.2 Partial fallback/comment deleted; local positive-safe-integer guard precedes ownership/parent construction. Focused registry and poll lifecycle tests pass 32/32; optional input types, parent validation/defaults and downstream signatures unchanged.
- [x] 1.3 Three current documentation surfaces now describe consuming Cordis-resolved cadence; generated instructions rendered, current stale-wording sweep returns no matches, instructions/docs gates pass. Pending M2 history unchanged.

## 2. Integration and delivery

- [x] 2.1 Full check passes 74 files/1746 tests with 1 existing skip. Built-module smoke rejects missing/zero/fractional cadence with no jobs or ownership files; real profile smoke passes with existing #233 projection warnings. Strict fixture validation passes; source/output evidence retained as inert text and temporary probe removed.
- [x] 2.2 Three expanded review seats clean on c83f071a82c6508f9bbf6a6a1b5aa0c5fabd7374, zero fix passes; exact-head CI 40232172671 all eight jobs pass. PR #376 merged as 025726f1b266c06c531dfd69610d8d267b41f409 and #340 closed. Archive only this fixture; M2 and PI acceptance issues remain pending.

## Risk packs

- Selected: Public API / CLI / script entry — 1.1/2.1 actual constructor failure and supported profile entry.
- Selected: Config / project setup — 1.2 retains optional inputs/parent schema defaults and removes only partial fallback.
- Selected: Concurrency / shared state / ordering — 1.2 existing native poll lifecycle tests retain one shared cadence; no timer/queue changes.
- Selected: Error handling / rollback / partial outputs — 1.1 fails before jobs/lock publication; old RED instance is cleaned safely.
- Selected: Documentation / migration notes — 1.3 corrected precondition, no direct-construction support promise.
- Not selected: File IO / path safety / overwrite; Auth / permissions / secrets; Schema / columns / units / field names — ownership/path algorithms and persistent/schema formats unchanged; rejection-before-ownership covered by 1.1.
- Not selected: Resource limits / large input / discovery; Legacy compatibility / examples; Release / packaging / dependency compatibility — no new allocation-heavy fallback, compatibility path or dependency; supported behavior retained by 1.2/2.1.
- Domain: CP4-adjacent constructor review in 2.2; no SHUD equations/defaults, raw/submodule/host edits or PI approval.
