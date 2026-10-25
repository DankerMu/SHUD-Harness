# Tasks

## 1. Root script gate

- [x] 1.1 Parent recorded before-fix mutation: temporary production script with strict-null error was accepted by default typecheck (exit 0); the parent-owned probe was removed.
- [x] 1.2 Implemented root noEmit program, default-command integration and root @types/node 24.19.2. Frozen install passed; all eight scripts were listed; invalid test/fixture probes were excluded; no emitted artifacts; the identical mutation failed at scripts/typecheck-probe.ts(2,25) with TS18048, and restored default typecheck passed.
- [x] 1.3 Updated Repository_Layout after changed-command smoke to document package-plus-root-script scope; docs check passed, base settings and package test exclusions unchanged.

## 2. Integration gates

- [x] 2.1 Full pnpm run check passed; test-guardrails passed 147/147; strict fixture validation passed. Broad lint-program diagnostic has no TS2688 but still exits 2 with out-of-scope package test diagnostics; no claim of a clean broad lint program.
- [x] 2.2 Expanded three-seat review round 1 clean and exact-head CI passed at 264d18376ff2c88a389fd1372544342ac948619c; PR #362 merged as 00db9b82170d800a47dcbebf1e66e6cccc312c57, #356 closed. This archive is independent; M2/#293/#318 remain pending PI acceptance.

## Risk packs

- Selected: Public API / CLI / script entry — 1.1/1.2 actual default command mutation proves rejection and restored success.
- Selected: Config / project setup — 1.2 membership/exclusion, base invariants and frozen install.
- Selected: Error handling / rollback / partial outputs — 1.1/1.2 temporary probe restoration, noEmit artifact check, fail propagation.
- Selected: Release / packaging / dependency compatibility — 1.2 root Node type pin matches existing packages; no dependency upgrades or host installation.
- Selected: Documentation / migration notes — 1.3 accurate coverage statement.
- Not selected: File IO / path safety / overwrite — no production IO changes; verification probes only in parent-owned temporary paths, restoration under error handling.
- Not selected: Schema / columns / units / field names — no domain schema or units change; schema check remains in 2.1.
- Not selected: Auth / permissions / secrets — no credential, raw or permission surface changes.
- Not selected: Concurrency / shared state / ordering — no runtime ordering changes; existing serial compiler chain preserved by 1.2.
- Not selected: Resource limits / large input / discovery — bounded compiler input membership checked in 1.2; no runtime discovery change.
- Not selected: Legacy compatibility / examples — no version migration or retired API; existing package check remains in 2.1.
- Selected domain: Scientific governance / PI gate / evidence lineage — truthful compiler gate evidence in 1.1/1.2; #293/#318 still require PI acceptance under 2.2.
- Not selected domain: Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility — scripts are typechecked but solver/units/input behavior unchanged.
- Not selected domain: dsh seam / profile / outbound-channel governance — no host/runtime/plugin/profile changes or dependency upgrades.
