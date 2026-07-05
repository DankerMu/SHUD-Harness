# Finding Verification - cand-final-da20028-05

Verifier verdict for: cand-da20028-05-profile-failure-running-state
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Verdict: CONFIRMED

Evidence: `raw-data-sandbox.ts:543-553` awaits `buildRawDataSeatbeltProfile()` and `createRawDataSeatbeltProfileFile()` without a catch; the only wrapper finish path is `finalizeToolResult()` at `raw-data-sandbox.ts:732-738`, which calls `markRunningToolFinished()`. A symlinked `profileRoot` or `tempRoot` reaches `ensureDirectoryOutsideProtectedRaw()` and throws at `raw-data-sandbox.ts:4418-4420` / `4459-4461`; that propagates to `BaseTool.run()` catch at `zero/packages/core/src/tool/base.ts:81-94`, which returns a failure `ToolResult` without marking the registry handle. Existing symlink regressions at `raw-data-sandbox.test.ts:3191-3238` use `runSandboxed()` without `runningToolRegistry`, while the direct tool-run helper can pass one via `raw-data-sandbox.test.ts:4315-4333`.

Note: The normal agent executor has its own post-`tool.run` mark, but the `RawDataSandboxedBashTool` public `run()` path with a registry is used by local tests and leaves this wrapper-owned terminal metadata path uncovered.
