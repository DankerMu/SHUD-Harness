# Finding Verification - cand-final-da20028-01

Verifier verdict for: cand-da20028-01-fuse-source-xor
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Verdict: CONFIRMED

Evidence: `ShudBashFuseSource` encodes exactly one source at `packages/core/src/tools/policy-gate-registry.ts:44-46`, but `resolveShudBashFuseRules()` returns `options.fuseRules` when `"fuseRules" in options && options.fuseRules` at `policy-gate-registry.ts:313-318`; `fuseRules: []` is truthy, so a merged object with both `fuseRules: []` and `fuseListPath` skips `loadFuseList(options.fuseListPath)` and passes an empty list into `RawDataSandboxedBashTool` via `policy-gate-registry.ts:113-126`.

Note: No runtime XOR guard or regression test for both fields present was found on the cited path.
