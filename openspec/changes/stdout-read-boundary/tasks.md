# Tasks

## 1. Output boundary and evidence

- [x] 1.1 Add behavioral regression cases for real symlink replacement, FIFO/directory rejection, descriptor cleanup and actual parent warning/output exclusion; preserve all existing UTF-8/short-read/truncation/missing-log assertions. Parent observed RED: 5 expected failures, 4 compatibility passes; GREEN: 9/9.
- [x] 1.2 Implement one descriptor-bound regular-file read in the shared stdout source; both submission and takeover still use it and focused tests pass.
- [x] 1.3 Record hardlink/final-component residual bounds in the m2-run-chain design risk section and update existing operational documentation after smoke proof; docs check passed.

## 2. Integration verification

- [x] 2.1 Parent ran a standalone built-module real-file smoke including FIFO with a bounded subprocess, profile:smoke, full pnpm run check (72 files, 1715 passed / 1 existing skip), and strict OpenSpec validation; outputs are in local .workplans/issue-348 evidence.
- [ ] 2.2 Independent expanded risk review and exact-head CI pass; close only #348 after merge, archive this fix separately, keep M2 Epic/acceptance open.

## Risk packs

- Selected: File IO / path safety / overwrite — 1.1/1.2 reject links and nonregular descriptors.
- Selected: Auth / permissions / secrets — 1.1 harmless sentinel never enters public output; no credentials/raw reads, no broader sandbox claim.
- Selected: Concurrency / shared state / ordering — 1.1 replacement between reads; descriptor binding instead of lstat/open race; ancestor swaps are an explicit non-goal.
- Selected: Resource limits / large input / discovery — 1.1 bounded FIFO and descriptor release; new large-log bounds explicitly out of scope.
- Selected: Error handling / rollback / partial outputs — 1.1/1.2 real warning-and-stop, prior output retained, finally closes; job rollback remains unchanged.
- Selected: Documentation / migration notes — 1.3 records limitations without changing schema.
- Not selected: Public API / CLI / script entry — no signature, tool or CLI changes; existing consumer integration covered by 1.1.
- Not selected: Config / project setup — unchanged; profile smoke in 2.1.
- Not selected: Schema / columns / units / field names — no persistent field changes.
- Not selected: Legacy compatibility / examples — no supported version migration; current stdout compatibility explicitly covered by 1.1.
- Not selected: Release / packaging / dependency compatibility — no dependencies or package shape change; existing build/check in 2.1.
- Selected domain: Scientific governance / PI gate / evidence lineage — 1.1 sentinel exclusion and prior-output preservation; 2.2 explicitly preserves pending M2/#293/#318 acceptance without agent approval.
- Selected domain: dsh seam / profile / outbound-channel governance — 1.1 actual parent warning-and-stop integration and 2.1 profile smoke; no host imports, outbound configuration or routing changes.
- Not selected domain: Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility — no solver/input/units change; ordinary log bytes and host mounting are verified without changing physical defaults.
