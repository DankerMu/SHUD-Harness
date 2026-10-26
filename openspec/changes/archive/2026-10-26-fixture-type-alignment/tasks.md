## Risk packs

- Selected: Legacy compatibility / examples — existing public type contracts, fixture runtime values, native job IDs and assertions remain compatible; tasks1.1–1.2.
- Selected: Error handling / rollback / partial outputs — preserve deliberately hostile remediation and fail-loud nonnull-object narrowing; tasks1.1–1.2.
- Selected: Documentation / migration notes — this fixture and PR distinguish historical13-error evidence from current post-fix results, and optional diagnostics from blocking policy; task1.3.
- Not selected: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Release / packaging / dependency compatibility — production APIs, IO/state machines, policy decisions, schema/config/dependencies and release behavior are unchanged. CP1/4 fixture oracle preservation still requires white-box review.

## 1. Align fixture typing without changing its oracle

- [x] 1.1 Repair the named7 test files: policy-gate-core context annotation and documented hostile-remediation boundary; role-tool-map mutable matcher input; kill-shud-grace/takeover-shud/teardown-shud public JobId bridges for6 use sites; kill-shud JobKind literal union; registry nonnull-object narrowing with an explanatory comment. Preserve all original runtime assertions/inputs and use no ts-ignore, lint-disable, any cast or widened production signature. Verify against current source contracts and the retained #356 historical RED log, without rerunning merely to confirm that report.
- [x] 1.2 Run pnpm exec tsc -p tsconfig.eslint.json --noEmit after the fixes and require exit0, then run all7 touched test files and pnpm run check. Compare scenario names/counts and runtime assertions to the integration base; verify production/compiler/CI/dependency and Repository_Layout policy bytes unchanged. Report actual current counts rather than repinning stale historical counts.
- [x] 1.3 Complete one correctness+test-evidence white-box review for the CP1/4 test oracles, exact-head CI, and public evidence with historical/current scope explicit. No runtime smoke or PI acceptance is claimed for type-only fixture edits; #293/#318 and m2-run-chain remain pending PI.
