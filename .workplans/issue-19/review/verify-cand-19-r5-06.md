# Finding Verification: cand-19-r5-06

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `containsFragmentedRawDataPathSignal` only matches `[data,raw].join("/")`, `"/".join([data,raw])`, `Path.join("data","raw")`, concatenation, or `/` operator forms at `packages/core/src/tools/raw-data-sandbox.ts:1109-1119`; it does not match `Path("data").joinpath("raw",...)`. The hidden-denial guard then allows commands with no static/dynamic raw write signal at `packages/core/src/tools/raw-data-sandbox.ts:513-518`, runtime denial detection requires visible denial output at `packages/core/src/tools/raw-data-sandbox.ts:1539-1544`, and a success result appends `decision: "allowed"` at `packages/core/src/tools/raw-data-sandbox.ts:348-354`. Spec requires interpreter payload raw writes to return failed remediation/audit evidence at `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:29-32`.

Note: The exact shell masking path is constructible: Python stderr is redirected to `/dev/null`, `|| true` returns success, leaving no denial output for post-run normalization.
