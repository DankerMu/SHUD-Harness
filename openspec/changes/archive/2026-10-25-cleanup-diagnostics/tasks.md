# Tasks

## 1. Failure evidence boundary

- [x] 1.1 Parent observed semantic RED (missing inner message) alongside 8 existing native fault tests passing, plus actual default-reporter nested abort probe omitting the inner sentinel. Source/receipts/output retained locally; no missing-module failure.
- [x] 1.2 Shared diagnostics retain nested/non-Error/cycle/stop-boundary proof. Review C1 fixed: enclosing identities enrich an already-captured diagnostic without resampling or changing its snapshot/references; actual cleanupResources composition regression and direct-node counterexample pass. Focused 31/31 pass; real cyclic default-reporter probe terminates with original evidence.
- [x] 1.3 Immediate pending/body observation now spans both early fault-test stops; native tests prove combined evidence, same-object body-only error, unchanged order and no later release after existing early stop failures.
- [x] 1.4 Actual default-reporter injection now exposes all five sentinels, real stack and receipt-matching pid/pgid/ps. Final candidate source digests and output retained, temporary probes removed; Testing_Strategy records use and historical non-claims. Finite deep-cause probe confirms original cause remains visible despite bounded summaries.

## 2. Regression and delivery

- [x] 2.1 Focused regressions and full pnpm run check pass after interval-only isolation of cleanup completion (74 files, 1738 passed/1 existing skip); native execution and pump timeouts remain real. Prior failure logs retained; unrelated #352 site 1 reproduced and recorded without modifying its tests. Strict fixture validation passes; exact-head CI 40216530399 all eight jobs pass. Production proof files/shared defaults unchanged.
- [x] 2.2 Expanded independent review and fresh fix re-review pass on 3b3ffdbe86b07d93efb53532d0bf3f2a6990dffa; one fix pass used. PR #369 merged as 863f2868f55ec81ef7b21097cd9b2e5fb43814f9 and #349 closed on delivered diagnostic criteria. Archive only this fixture; historical trace-free failures remain unknown and M2 PI acceptance remains pending.

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
