# Tasks

## 1. Synchronized migration

- [x] 1.1 Upgrade all Vitest declarations and coverage-v8 to 5.0.5, add root Vite 8.3.4, regenerate the lock and prove frozen install without auto peers; retain TypeScript/Node/host pins.
- [x] 1.2 Remove only Vitest/coverage-v8 major ignores and update canonical version documentation plus generated instructions; verify render drift check and unchanged remaining ignores.
- [x] 1.3 Compare the default full check against #233 evidence: discovery/counts, four coverage metrics and unchanged policy; investigate any mismatch without weakening tests/config. Run actual profile smoke and preserve output.

## 2. Delivery

- [x] 2.1 Review the complete dependency/config/docs diff, pass exact-head CI and publish evidence; keep #289 open with its unsupported TS7 remainder explicitly recorded.
- [x] 2.2 Archive this completed runner slice without archiving the M2 acceptance fixture.

## Risk mapping

- Selected Config / project setup → 1.1 frozen install and 1.3 default check.
- Selected Release / packaging / dependency compatibility → 1.1 explicit peer/synchronized provider; 1.3 actual smoke; 2.1 CI.
- Selected Documentation / migration notes → 1.2 rendered versions and 2.1 explicit TS7 blocker.
- Public API / CLI / script entry not selected: no application entry or command contract change; existing CLI exercised by 1.3.
- File IO / path safety / overwrite, Schema / columns / units / field names, Auth / permissions / secrets, Concurrency / shared state / ordering, Resource limits / large input / discovery, Legacy compatibility / examples, Error handling / rollback / partial outputs not selected: production behavior unchanged, existing full suite retained; no new runtime implementation in this slice.
