# Review report -- test evidence -- observable 37cd38e

Reviewer agent: review-test-evidence
Review round: observable-boundary comprehensive round
Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Summary: Observable-boundary scope is aligned and core evidence is covered, with one P2 reproducibility gap in unavailable-seatbelt/interpreter skip handling.

Invariant Matrix Coverage:
- Six escape classes: covered with real seatbelt tests where available.
- Observable denials produce remediation/tool.failed/audit: covered.
- Hidden/suppressed denials out of telemetry scope: covered.
- Legal raw read, workspace write, waited foreground child writes: covered.
- Hardlink residual and bounded scan: covered.
- Static advisory: covered.
- macOS seatbelt execution and unavailable-environment skip behavior: missing; see finding 1.
- `zero` unchanged and local command coverage: covered.

Findings:
- Severity: P2
  Failure class: test-evidence reproducibility / unavailable-environment gating
  Contract or invariant: Tests requiring real macOS seatbelt and optional interpreters should run when available and skip correctly when unavailable.
  Scenario: On Linux or macOS without `/usr/bin/sandbox-exec`, `node`, or `python3`, plain `test(...)` cases call `runSandboxed()` and assert success. Without seatbelt the wrapper fails before execution, so CI/dev runs fail instead of skipping.
  Evidence: skip helpers exist, but runtime cases around fragmented interpreter path, truncated hidden interpreter scan, and `chr`-concatenated hidden writes use plain `test(...)`; GitHub CI on Linux failed on exactly these cases plus a `/tmp` profile-text assertion.
  Consequence: local Mac evidence passes but CI does not give clean skip behavior for unavailable authority.
  Fix direction: convert runtime cases to `nodeSeatbeltTest` or `pythonSeatbeltTest` as appropriate; audit direct `runSandboxed()` callers.
  Required test/proof: rerun `bun run test:policy-gate` locally and in CI/non-seatbelt environment.
  Sibling surfaces: raw sandbox tests, registry seatbelt-gated tests, root `bun run check`.
  Blocks merge: yes for evidence/CI.

Non-blocking notes:
- Historical `.workplans` files are SHA/round-scoped and superseded by current issue/OpenSpec text.
