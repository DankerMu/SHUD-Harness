# Tasks

## 1. Failure evidence boundary

- [x] 1.1 Parent observed semantic RED (missing inner message) alongside 8 existing native fault tests passing, plus actual default-reporter nested abort probe omitting the inner sentinel. Source/receipts/output retained locally; no missing-module failure.
- [x] 1.2 Shared test-only diagnostics now cover detached/submission/poll wrappers; focused 29/29 pass for nested/multiple/cause/non-Error/cycle evidence, unavailable snapshot preservation, no success snapshot and each existing stop/continue boundary.
- [x] 1.3 Immediate pending/body observation now spans both early fault-test stops; native tests prove combined evidence, same-object body-only error, unchanged order and no later release after existing early stop failures.
- [x] 1.4 Actual default-reporter injection now exposes all five sentinels, real stack and receipt-matching pid/pgid/ps. Final candidate source digests and output retained, temporary probes removed; Testing_Strategy records use and historical non-claims. Finite deep-cause probe confirms original cause remains visible despite bounded summaries.

## 2. Regression and delivery

- [ ] 2.1 Parent runs focused diagnostic/lifecycle regressions, full pnpm run check (including coverage/dup), strict fixture validation and exact-head CI; production proof files and shared defaults unchanged.
- [ ] 2.2 Expanded independent review passes, merge/close #349 on delivered diagnostic criteria and archive only this fixture; do not claim historical trace-free failures solved or M2 PI accepted.

## Risk packs

- Selected: Public API / CLI / script entry — 1.1/1.4 actual default reporter as operational boundary, no config switch.
- Selected: Concurrency / shared state / ordering — 1.2/1.3 original cleanup sequence, quiescence gate and immediate pending observation.
- Selected: Error handling / rollback / partial outputs — 1.2/1.3 nested/primary preservation, snapshot failure, rejected cleanup remains rejected.
- Selected: Resource limits / large input / discovery — 1.2 cycle-safe diagnostics and bounded ps call; no process command lines or success-path snapshot cost.
- Selected: Documentation / migration notes — 1.4 evidence and explicit historical non-claim.
- Not selected: Config / project setup — no reporter/default/toolchain config changes.
- Not selected: File IO / path safety / overwrite — no production IO changes; parent-owned reporter probe removed and existing destructive cleanup gate preserved by 1.2.
- Not selected: Schema / columns / units / field names — no persistent fields or domain units.
- Not selected: Auth / permissions / secrets — diagnostic command fixed to pid/pgid/stat, no environment/raw/credentials; no permission changes.
- Not selected: Legacy compatibility / examples — no version migration; unchanged lifecycle covered by 2.1.
- Not selected: Release / packaging / dependency compatibility — no dependency changes.
- Selected domain: Scientific governance / PI gate / evidence lineage — 1.1/1.4 truthful captured versus unknown failure history, 2.2 PI gate preserved.
- Not selected domain: Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility — fake fixture processes only, no solver/input/units changes.
- Not selected domain: dsh seam / profile / outbound-channel governance — host production seams/routing unchanged, existing tests exercise their fixtures without changing APIs.
