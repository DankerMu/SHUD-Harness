# Tasks

## 1. Failure evidence and implementation

- [x] 1.1 Five behavioral release/initialization cases fail semantically against unchanged production, with 39 existing native cases passing (red-public-logger.txt). Earlier RED logs retain a test-observation repair: Cordis copies logger prototype descriptors, so the test now observes the public root exporter and actual disposal-owned close, not a late prototype spy. No timeout remains; the reported permission observation was not rerun merely for confirmation.
- [x] 1.2 One-shot release diagnostics, self-residue refusal and initialization aggregate preservation implemented; focused 44/44 pass including original references, one visible outer-error report, memoized close, foreign/busy refusal and unknown close outcome.
- [x] 1.3 Both fault paths preserve index bytes and guard inode; the actual child acquires the released guard while registry acquisition remains refused, and owner-checked recovery under continuous exclusion restores valid indexes. Existing admission/drain/stale/non-SHUD tests pass. Invalid index restoration remains an explicit separate fixture step.
- [x] 1.4 Pending M2 spec/design failure wording synchronized; original checked task 8.1 line proven byte-identical and dated follow-up appended. Source instructions/rendered projections and runtime recovery docs updated; both changes strictly validate, docs gate passes, M2 remains unarchived.

## 2. Runtime qualification and delivery

- [x] 2.1 Focused 44/44 and full check 74 files/1743 tests with 1 existing skip pass. Built Darwin chmod0500 smoke proves EACCES diagnostics, real child guard acquisition, live-self refusal, same rejection and guarded recovery with unchanged nonempty indexes/inode; final source rerun also passes. Profile smoke passes with existing #233 projection limitations. All earlier lint/format/path failures and repairs retained; no gate changes. Owned temporary script/directory removed, source evidence retained as inert text.
- [x] 2.2 Three critical-path review seats clean on cd736e64034e311d0ffc8328a90505489e6b8e7a, zero fix passes; exact-head Linux CI 40227800141 all eight jobs pass. PR #374 merged as d9742bb3e540f5c03974eef22cfe34667f101bdf and #335 closed. Archive only this independent fixture; #293/#318 and M2 remain pending PI acceptance.

## Risk packs

- Selected: Public API / CLI / script entry — 1.2/1.3 exercise actual store/registry apply/disposal and 2.1 built runtime, no new API.
- Selected: File IO / path safety / overwrite — 1.3 native exclusion, metadata/index bytes, permanent dev/ino; guarded operator removal only.
- Selected: Auth / permissions / secrets — 1.1/2.1 EACCES/real permission evidence, no bypass or arbitrary raw payload added to diagnostic text.
- Selected: Concurrency / shared state / ordering — 1.2/1.3 unlink-under-guard, close-after-error, drain/memoized close, never a second writer.
- Selected: Error handling / rollback / partial outputs — 1.1–1.3 preserve both errors and distinguish actual guard outcomes.
- Selected: Resource limits / large input / discovery — 1.2 zero automatic retries/new timers/helpers, one attempt and closed admission.
- Selected: Legacy compatibility / examples — 1.3 foreign/live/stale and non-SHUD behavior; 2.1 profile smoke.
- Selected: Documentation / migration notes — 1.4 precise recovery and unchanged availability limitation.
- Not selected: Config / project setup; Schema / columns / units / field names; Release / packaging / dependency compatibility — no config/format/dependency or packaging changes.
- Domain: Critical Path #4 ownership reviewed in 2.2; scientific defaults, solver/submodule bytes, host source and PI gate are explicit non-goals.
