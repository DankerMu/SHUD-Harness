# Finding Verification: cand-19-r5-09

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `execute()` returns `denied_by_advisory` before spawning when `evaluateRawDataWriteAdvisory()` denies (`packages/core/src/tools/raw-data-sandbox.ts:310-323`); `splitStaticShellSegments()` splits on any `&` (`packages/core/src/tools/raw-data-sandbox.ts:1160`), so `(cd workspace && printf ok > data/raw/out.txt)` is seen as `(cd workspace` then `printf ok > data/raw/out.txt)`, while `isCwdChangingCommand()` only matches `cd|pushd|popd` (`packages/core/src/tools/raw-data-sandbox.ts:1510-1512`) and `isRawDataPathToken()` treats relative `data/raw/...` as protected unless cwd is ambiguous (`packages/core/src/tools/raw-data-sandbox.ts:1298-1304`). The fixture separates protected `root/data/raw` from allowed `root/workspace` (`rawRoot` vs `workspaceRoot`, `packages/core/src/tools/raw-data-sandbox.test.ts:1051-1054`), and the spec requires workspace writes to succeed (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:34-37`).

Note: None.
