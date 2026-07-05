# Review report -- PR #48 observable fbc0cc0 test-evidence

Reviewer agent: review-test-evidence
Review round: follow-up observable fbc0cc0
Reviewed head SHA: fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48

Summary:
One blocking evidence drift remains: runtime/tests now treat post-exec sandbox output as generic lifecycle, but OpenSpec/tasks/design still require `denied_by_sandbox` telemetry for visible OS denials.

Invariant Matrix Coverage:
- Task 3.3 / clause 2' source-of-truth contract: missing - OpenSpec spec, tasks, and design still say process-result-visible OS denials must produce remediation-shaped raw denial telemetry with `decision=denied_by_sandbox`; current code/tests intentionally no longer do that.
- macOS seatbelt byte authority: covered.
- Ubuntu/non-seatbelt CI boundary: covered; GitHub `check` passed for `fbc0cc0`.
- Legal raw reads and workspace writes: covered.
- Advisory fail-open and remediation: covered.
- Conservative telemetry / no false raw-denial claim: covered.
- Outer raw-rule deny mismatch: covered.
- Audit minimum row and fixture path: covered.
- Hardlink residual and bounded scan: covered.
- WS `tool.failed` skeleton: covered with caveat; synthetic `denied_by_sandbox` payload test should be described as payload-shape-only if the spec is updated.
- Non-goals for hidden denial and arbitrary descendant ownership: covered.

Findings:
- Severity: P1
  Failure class: Spec/evidence drift.
  Violated invariant/contract: Selected task and required evidence must describe the same telemetry boundary implemented by code and verified by tests. Current accepted strategy says post-exec process output alone is generic lifecycle, not raw-denial telemetry.
  Concrete scenario: On macOS, with advisory disabled, `printf visible > data/raw/over-budget-visible.txt || true` is byte-blocked by seatbelt but returns generic lifecycle evidence. Current regression expects no `raw_data_write_denied` and no `denied_by_sandbox` audit row. OpenSpec still says visible OS denials must produce remediation-shaped `tool.failed`/audit evidence with `decision=denied_by_sandbox`.
  Evidence: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25`, `spec.md:34`, `openspec/changes/m1-foundation/tasks.md:33`, `openspec/changes/m1-foundation/design.md:178`, `packages/core/src/tools/raw-data-sandbox.ts:414`, `packages/core/src/tools/raw-data-sandbox.test.ts:3103`.
  Consequence: Canonical acceptance text contradicts implementation and regression suite.
  Fix direction: Update `policy-gate-spike/spec.md`, `tasks.md`, and design invariant matrix to state the current M1 boundary: raw-denial telemetry is for advisory/pre-exec denials and future trusted OS-denial evidence; post-exec process output alone records generic lifecycle audit rows.
  Required verification: Point to the generic lifecycle regression, rerun OpenSpec validation and `bun run check`.
  Sibling surfaces: backend synthetic `denied_by_sandbox` payload test, historical `.workplans` reports, PR description validation claims, future audit/WS consumers.
  Blocking status: blocking for evidence/spec consistency before merge.

Non-blocking notes:
- Historical review artifacts remain SHA-scoped; do not cite prior-head positive `denied_by_sandbox` claims as current proof after fbc0cc0.
- GitHub PR check status passed for `fbc0cc0`.

Execution Summary: agents=review-test-evidence; skills=review; tools=git, rg, sed, nl, gh, multi_tool_use.parallel; verification=read-only diff/context review plus GitHub PR check query; limits=no file edits, no subagents.
