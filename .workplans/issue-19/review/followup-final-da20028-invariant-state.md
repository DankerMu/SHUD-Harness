# Follow-up Comprehensive Review - invariant/state at da20028

Reviewer agent: review-invariant-state
Review round: final comprehensive follow-up after b246582 fixes
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`

Summary: Finding reported in terminal failure state finalization before profile execution.

Invariant Matrix Coverage:
- Running tool terminal state is finalized for normal run/advisory/process paths: covered.
- Pre-exec profile build/write failures with a `runningToolRegistry`: missing.
- Timeout/abort cleanup state transition: partially covered; see security/perf process ownership finding.

Findings:
- P2 `state-transition`: `buildRawDataSeatbeltProfile()` / `createRawDataSeatbeltProfileFile()` can throw before `finalizeToolResult()` is reached. With `runningToolRegistry`, the error falls to Zero `BaseTool.run()` catch and returns a failure `ToolResult` without marking the wrapper's running handle finished. Required fix: catch profile build/write failures into a structured `ToolResult` that passes through `finalizeToolResult()`, and add a `runningToolRegistry` regression for symlinked `profileRoot` or `tempRoot`.

Non-blocking notes:
- `zero` diff clean and pinned.
- `git diff --check origin/main...HEAD` passed.
