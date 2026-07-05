# Follow-up Comprehensive Review - integration/API at da20028

Reviewer agent: review-integration
Review round: final comprehensive follow-up after b246582 fixes
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`

Summary: Findings reported in fuse-source runtime contract and test-support subpath exposure.

Invariant Matrix Coverage:
- Raw byte authority remains OS seatbelt-backed: covered.
- Advisory is observable only and not final authority: covered.
- Public API/test-support boundary: missing for `@shud-harness/core/*` subpath alias.
- Fuse wrapper source identity: missing runtime XOR guard.

Findings:
- P2 `contract`: `ShudBashFuseSource` is typed as XOR, but `resolveShudBashFuseRules()` accepts an untyped object containing both `fuseRules: []` and `fuseListPath`, then returns the empty inline rules and skips `loadFuseList()`. Required fix: add runtime exactly-one-source validation and a double-source regression.
- P2 `contract`: root export whitelist is clean, but `tsconfig.base.json` maps `@shud-harness/core/*` to `packages/core/src/*`, so `@shud-harness/core/tools/raw-data-sandbox-test-support` is constructible inside the monorepo and exposes test-only raw-denial/process helpers as a package-like subpath. Required fix: remove or narrow the subpath alias and/or move test-only seams outside the aliased source tree; add an import-boundary regression if available.

Non-blocking notes:
- `tsc --noEmit -p tsconfig.json` passed in the reviewer environment.
- `bun` was not available in the reviewer environment.
