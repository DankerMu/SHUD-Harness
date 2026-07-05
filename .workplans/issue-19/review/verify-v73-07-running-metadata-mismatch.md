# Verifier Verdict: V73-07-running-metadata-mismatch

Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679
Verdict: CONFIRMED
Severity: P1

Evidence: `runSeatbeltSandboxedBash()` marks normal completion on the running handle before outer denial normalization and audit fail-closed handling. Zero later tries to mark the final ToolResult, but `SessionRunningToolHandle.markFinished()` refuses updates once finished.

Disposition: merge-blocking. The fix must ensure running metadata is finalized only once with the wrapper's final result, while preserving timeout/abort causes.
