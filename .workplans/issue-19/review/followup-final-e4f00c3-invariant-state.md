# Follow-up Comprehensive Review - invariant/state at e4f00c3

Reviewer agent: review-invariant-state
Review round: final comprehensive follow-up after da20028 boundary/runtime fixes
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`

Summary: One P2 state-transition gap remains in pre-profile raw-root canonicalization; da20028 timeout/cleanup, evidence-boundary, timeout-bounds, and test-support fixes otherwise trace as covered.

Invariant Matrix Coverage:
- Running handle terminal metadata for all wrapper-owned terminal paths: missing for stale/deleted `protectedRawPaths` before profile setup.
- Timeout/abort cleanup cannot signal unrelated host processes or leak descendants under selected assumptions: covered.
- Raw denial/advisory evidence state is trusted only from internal path: covered.
- Package/test-support boundary preserves compatibility while hiding seams: covered.
- Process containment preflight remains advisory/scope-correct and waited foreground children allowed: covered.

Findings:
- P2 `state-transition / error-handling`: duplicate stale/deleted `protectedRawPaths` pre-finalize gap at `packages/core/src/tools/raw-data-sandbox.ts:552`. Required proof: `TestRunningToolRegistry` regression where missing absolute protected raw root fails structurally and marks terminal metadata.

Non-blocking notes:
- Prior da20028 findings for fuse-source XOR, test-support subpath exposure, invalid timeout side effects, root PID cleanup, and profileRoot/tempRoot finalization appear closed.
