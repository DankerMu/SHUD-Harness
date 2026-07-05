# Finding Verification: cand-19-r5-10

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:326-332` wraps the user command as `sandbox-exec -f ${profilePath} bash -c ...` and passes `createInnerSandboxToolContext(ctx)` to the inner tool; `packages/core/src/tools/raw-data-sandbox.ts:778-783` spreads `...ctx` without removing `currentToolUseId` or `runningToolRegistry`; `zero/packages/core/src/tool/bash.ts:344-346` retrieves that live handle, and `zero/packages/core/src/tool/bash.ts:418-420` marks timeout finished with `Command timed out: ${summaryCommand}` where `summaryCommand` is derived from the wrapped command. `zero/packages/core/src/session/running-tool-registry.ts:57-60` stores the first terminal metadata and refuses later overwrite once finished.

Note: Outer `normalizeSandboxedBashResult` sanitizes the returned `ToolResult`, but it runs after the inner BashTool has already written terminal metadata.
