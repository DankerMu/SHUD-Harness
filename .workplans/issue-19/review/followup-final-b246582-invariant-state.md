# Follow-up Comprehensive Review — invariant/state

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Reviewer: Pasteur (`019f329b-6694-7e83-bed9-1580a2285470`)
Verdict: FINDINGS

Finding 1:
- Severity: P2
- Failure class: telemetry replay / provenance
- Candidate: same actual trusted `ToolResult` can be used to build multiple WS envelopes.

Finding 2:
- Severity: P2
- Failure class: public reserved-decision API boundary
- Candidate: package root exposes `buildRawDataDeniedPayload()` and `buildRawDataDeniedToolResult()`, allowing callers to construct reserved-looking raw-denial payload/tool-result values even if public WS/audit sinks reject them.

Finding 3:
- Severity: P2
- Failure class: descendant tracker identity / host process safety
- Candidate: process identity uses `ps lstart` second-level timestamp. A PID reused within the same second can collide with a sampled child identity and be signaled as current invocation.

Verification cited:
- Focused suite: pass.
- Diff and zero checks: pass.
