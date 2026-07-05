# Finding Verification - cand-final-da20028-03

Verifier verdict for: cand-da20028-03-timeout-runtime-bounds
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:597-604` spreads caller input into `runSeatbeltSandboxedBash()` without normalizing `timeout`; line `1425` uses `const { command, timeout = 120_000 } = input;`; lines `1524-1531` pass `timeout` directly to `setTimeout()`. `BaseTool.run()` only validates required-field presence, not type/min/max, at `zero/packages/core/src/tool/base.ts:73-75` and `101-117`.

Note: `RawDataSandboxedBashTool` copies BashTool metadata, whose `timeout` schema is only `{ type: "number", description: ... }` with no finite/min/max bounds.
