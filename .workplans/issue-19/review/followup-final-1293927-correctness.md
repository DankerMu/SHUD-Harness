# Final Follow-up Review 1293927 - Correctness

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict: NOT CLEAN

## Blocking Findings

- `cand-final-1293927-02-afterexecute-terminal-metadata` (P2): `RawDataSandboxedBashTool.execute()` finalizes the running tool handle before Zero `BaseTool.afterExecute()` runs. If `afterExecute()` throws, `BaseTool.run()` returns a new failed `ToolResult`, but `RunningToolHandle.markFinished()` refuses to overwrite the earlier success metadata. The final result and terminal metadata can diverge.

## Evidence

- `packages/core/src/tools/raw-data-sandbox.ts`: `run()` calls `super.run()` then marks the handle again, while `execute()` paths already call `finalizeToolResult()`.
- `zero/packages/core/src/tool/base.ts`: `afterExecute()` runs after `execute()` and is inside the same catch that converts thrown errors into failed `ToolResult`.
- `zero/packages/core/src/session/running-tool-registry.ts`: `markFinished()` is idempotent and does not overwrite existing terminal metadata.

## Verification Read

Reviewer inspected the PR diff, `RawDataSandboxedBashTool`, Zero `BaseTool`, `RunningToolRegistry`, WS builder, and ran focused policy-gate tests plus full `bun run check`; tests passed but the edge path was uncovered.
