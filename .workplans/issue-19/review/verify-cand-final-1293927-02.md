# Verifier Report - cand-final-1293927-02-afterexecute-terminal-metadata

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict: CONFIRMED

## Evidence

- `RawDataSandboxedBashTool.execute()` paths call `finalizeToolResult()` before Zero `BaseTool.afterExecute()`.
- `BaseTool.run()` calls `afterExecute()` after `execute()` and catches `afterExecute()` errors by returning a new failed `ToolResult`.
- `RunningToolHandle.markFinished()` refuses to overwrite terminal metadata once finished.
- Therefore an `afterExecute()` failure can leave terminal metadata on the earlier success or earlier summary while the returned `ToolResult` is failed.

## Merge Impact

Blocks merge. This does not break raw byte authority, but it breaks the #19 observability/running-handle boundary.

## Minimal Fix

Delay running-handle finalization until `RawDataSandboxedBashTool.run()` receives the final `ToolResult` from `super.run()`, while preserving per-invocation timeout/abort/spawn_error cause. Add a regression for an `afterExecute()` failure path.
