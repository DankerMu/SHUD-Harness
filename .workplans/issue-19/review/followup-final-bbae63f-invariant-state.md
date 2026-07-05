# Follow-up Comprehensive Review — invariant/state

Reviewed head SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Reviewer: Descartes (`019f327a-acad-7b13-8794-1d871998e454`)
Verdict: FINDING

Finding:
- Severity: P2
- Failure class: telemetry replay / provenance
- Files:
  - `packages/backend/src/ws/index.ts`
  - `packages/core/src/tools/raw-data-sandbox.ts`
- Candidate: the same sandbox-owned advisory-denied `ToolResult` can be used repeatedly to generate different WS event identities, because the builder accepts caller `seq/eventId/timestamp` and the trusted input helper is not one-shot.

Other reviewed surfaces:
- No new finding for write-authorized roots, relative root binding, post-exec `denied_by_sandbox` overclaiming, bounded descendant sampling, or `zero/` diff.
