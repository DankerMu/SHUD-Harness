# Finding Verification - cand-final-da20028-02

Verifier verdict for: cand-da20028-02-test-support-subpath
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Verdict: CONFIRMED

Evidence: `tsconfig.base.json:24-25` maps `"@shud-harness/core/*"` to `"packages/core/src/*"`, while `packages/core/src/tools/raw-data-sandbox-test-support.ts:1-9` re-exports the raw-denial builders and `*ForTest` seams; `packages/backend/tsconfig.json:2-5` inherits that alias for backend `src/**/*.ts`, so `@shud-harness/core/tools/raw-data-sandbox-test-support` is a constructible in-repo production subpath import despite the root-only absence test at `packages/core/src/tools/raw-data-sandbox.test.ts:105-120`.

Note: `packages/core/package.json` only exports `"."`, but the monorepo TypeScript path alias bypasses that package export boundary for in-repo code.
