# Tasks

## 1. Event and aggregate boundary

- [x] 1.1 Recorded before-change missing-label-event assertion failure and implemented all five event types, preserving push/permissions/jobs/thresholds. Hosted grant/revoke acceptance remains separately tracked in 2.1.
- [x] 1.2 Extracted one success-only aggregator shell used by CI and test-guardrails. Actual command returned 0 for all-success and 1 for each failure/cancelled/skipped case; guardrail suite passed 151/151.
- [x] 1.3 After aggregate-command smoke, updated source instructions, constraints comment and PR template with full-CI/cancellation cost, added proposed ADR-0008 and regenerated instructions; full check/docs passed.

## 2. Hosted proof and delivery

- [ ] 2.1 Parent opens a never-merged oversized draft proof PR and records same-head opened failure -> labeled green+bypass -> unlabeled red for size AND aggregate, without commits/reopen between label events; close draft and preserve logs.
- [ ] 2.2 Full pnpm run check, test-guardrails, strict fixture validation, independent expanded review and exact-head CI pass; merge/close #324 and archive only this fixture, not M2 acceptance.

## Risk packs

- Selected: Public API / CLI / script entry — 1.2 real aggregate command success/error matrix.
- Selected: Config / project setup — 1.1 preserved default events and needs, 2.1 actual hosted workflow.
- Selected: Concurrency / shared state / ordering — 2.1 same-head sequential label events prove newest state; existing cancellation group unchanged and cost disclosed.
- Selected: Error handling / rollback / partial outputs — 1.2 skipped/cancelled/failed fail closed; 2.1 unrelated failures distinguished from size failures and owned proof PR closed.
- Selected: Documentation / migration notes — 1.3 source/mirrors/template/ADR and render parity.
- Not selected: File IO / path safety / overwrite — no product file IO; only parent-owned proof files, no worktrees/user deletion.
- Not selected: Schema / columns / units / field names — no domain format changes.
- Not selected: Auth / permissions / secrets — permissions remain contents:read, no privileged trigger/admin bypass; explicit non-goal in design.
- Not selected: Resource limits / large input / discovery — threshold unchanged; runner cost explicit in 1.3, no runtime resource change.
- Not selected: Legacy compatibility / examples — no version or API migration; original triggers retained under 1.1.
- Not selected: Release / packaging / dependency compatibility — no new dependencies or versions; full check in 2.2.
- Selected domain: Scientific governance / PI gate / evidence lineage — 2.1 live raw logs vs claims; 2.2 preserves pending #293/#318.
- Not selected domain: Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility — no solver changes.
- Not selected domain: dsh seam / profile / outbound-channel governance — unchanged host/profile; existing CI profile-smoke retained.
