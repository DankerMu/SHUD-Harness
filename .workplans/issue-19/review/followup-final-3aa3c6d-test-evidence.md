# Phase 6.5 Follow-up Review: Test & Evidence

Reviewer agent: review-test-evidence
Review round: final follow-up round after fixes
Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Summary: Verification now passes, but relative `protectedEvidencePaths` coverage is incomplete and abort-containment test fake fidelity has a plausible flake.

Invariant Matrix Coverage:
- OS seatbelt byte authority: covered by real macOS tests for the six escape classes.
- Stable relative root binding: missing for positive relative `protectedEvidencePaths` regression.
- Trusted raw-denial telemetry boundary: covered for reserved `denied_by_sandbox` public converter rejection and OpenSpec post-exec attribution narrowing.
- Post-exec output cannot upgrade to sandbox denial: covered.
- Legal raw reads, workspace writes, waited foreground children: covered.
- Pre-existing hardlink residual and bounded scan: covered.
- Evidence pipeline ToolResult -> audit -> WS: covered.
- Outer raw-rule evaluator misuse: covered.
- Audit/profile path safety and cleanup identity: covered.
- Downstream/local verification: orchestrator reruns passed.

Findings:
- Severity: P2
  Failure class: test/evidence coverage gap
  Contract or invariant: Relative raw/evidence/workspace runtime roots must bind to an explicit stable project root, not process cwd or per-call `ctx.workDir`.
  Evidence: Spec names relative raw/evidence/workspace roots; implementation resolves `protectedEvidencePaths`, but tests cover relative raw/audit/missing-base and only absolute protected-evidence positive behavior.
  Concrete scenario: Future regression resolves `protectedEvidencePaths: ["workspace/protected-evidence"]` against cwd or nested workdir; current tests may still pass.
  Consequence: A selected high-risk invariant can regress without direct test failure.
  Fix direction: Add macOS seatbelt regression for relative `protectedEvidencePaths`, changed cwd, nested `ctx.workDir`, and stable `pathResolutionRoot`.
  Required verification: Focused raw/registry/WS tests and root `bun run check`.
  Blocks merge: yes for high-risk evidence gate.

- Severity: P2
  Failure class: flaky verification / fake integration mismatch
  Contract or invariant: Local verification for touched modules must be reliable and abort tests must exercise the real running-tool abort contract.
  Evidence: Test fake `setAbortHandler()` only assigns the handler, while Zero real handle replays already requested aborts; fixed sleep can race handler registration.
  Concrete scenario: Abort requested before wrapper registers handler; fake accepts but never replays abort, so command can complete and false-fail.
  Consequence: Focused evidence command can flake under load.
  Fix direction: Make the test fake replay pending aborts like Zero or synchronize on handler registration.
  Required verification: Re-run abort-focused tests and full focused command.
  Blocks merge: verifier-dependent; high-risk PLAUSIBLE blocks in this workflow.

Non-blocking notes:
- Historical evidence is SHA-scoped.

