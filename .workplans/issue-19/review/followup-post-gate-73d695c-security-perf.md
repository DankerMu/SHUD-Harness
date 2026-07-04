# review-security-perf

Review round: post-gate follow-up after fixes
Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679

Summary: Not clean; process/audit durability and advisory scan gaps remain.

Invariant Matrix Coverage:
- Governing invariant: missing - timeout/abort cleanup only kills the original process group.
- Source-of-truth identity/contract: missing - delayed background audit subtree moves can remove the canonical audit row after success.
- Producers/storage/failure paths: missing for escaped descendants and delayed audit sabotage.
- Six escape classes: covered for direct raw-byte denial; remaining issues are evidence/process durability.
- Legal raw read/write: missing for interpreter exception-swallow snippets after `cd workspace`.
- Hardlink residual and bounded scan: covered.
- Advisory behavior: missing for cwd-ambiguous interpreter suppression.
- Zero cleanliness: covered.

Findings:
- P1 / process cancellation escape: a child that calls `setsid()` or `setpgrp()` can leave the original process group and write after timeout/abort returns. Required fix: supervise or prohibit process/session escape and add timeout/abort regressions.
- P1 / audit evidence integrity race: a successful command can start `(sleep 2; mv workspace/tasks workspace/tasks.moved) &`, exit, allow the wrapper to append `tool.completed`, then move the canonical audit subtree after return. Required fix: protect audit durability beyond append or kill/reap all descendants before returning, with delayed-sabotage tests.
- P1 / advisory false denial: after `cd workspace`, an interpreter snippet that writes only `workspace/data/raw` with swallowed exceptions can be pre-denied because cwd ambiguity is not carried into interpreter suppression scanning. Required fix: carry cwd/ambiguity or defer relative interpreter paths after cwd changes to the OS sandbox.
- P2 / unbounded pre-exec scan: very large interpreter payloads with many unmatched helper calls can force repeated full-string scans before subprocess timeout starts. Required fix: add command/payload length and scan-step budgets with tests.

Non-blocking notes:
- Reviewer was read-only and did not run the test suite.
