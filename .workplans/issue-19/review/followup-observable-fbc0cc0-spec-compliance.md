# Review report -- PR #48 observable fbc0cc0 spec-compliance

Reviewer agent: review-spec-compliance
Review round: follow-up observable fbc0cc0
Reviewed head SHA: fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48

Summary:
One P1 candidate: the implementation follows the conservative fbc0cc0 telemetry strategy, but canonical OpenSpec/ADR/design text still requires observable OS denials to emit raw-denial telemetry.

Invariant Matrix Coverage:
- Byte authority / six escape classes: covered.
- Advisory fail-open / same-root raw evidence: covered.
- Conservative post-exec telemetry downgrade: missing - code/tests now record generic lifecycle for post-exec OS denials, while spec/design/ADR still require `denied_by_sandbox` for visible OS denials.
- Custom outer raw-rule deny: covered.
- Legal raw read / workspace write / waited foreground child: covered.
- Hardlink residual and bounded scan: covered.
- WS `tool.failed` skeleton: covered within M1 skeleton scope.
- Zero ownership boundary: covered.

Findings:
- Severity: P1
  Failure class: spec/implementation contract drift; telemetry evidence scope mismatch.
  Violated invariant/contract: OpenSpec clause 2' and Decision 13 still say observable OS-layer raw denials produce remediation-shaped tool failure, `tool.failed`, audit row, and `decision=denied_by_sandbox`; fbc0cc0 treats post-exec process output as generic lifecycle unless the sandbox tool's own advisory/static path catches the denial.
  Concrete scenario: With `enableAdvisory: false`, a dynamic/advisory-disabled raw write is byte-blocked by seatbelt, but the wrapper appends generic `tool.failed` / `decision=failed` and returns a generic command failure with no `raw_data_write_denied` payload. Current tests assert this generic behavior.
  Evidence: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25`, `spec.md:34`, `openspec/changes/m1-foundation/design.md:42`, `design.md:178`, `docs/adr/0001-agent-runtime-and-topology.md:138`, `packages/core/src/tools/raw-data-sandbox.ts:414`, `packages/core/src/tools/raw-data-sandbox.test.ts:1611`, `packages/core/src/tools/raw-data-sandbox.test.ts:3379`.
  Consequence: OpenSpec acceptance, reviewers, and future WS/audit consumers can require `denied_by_sandbox` even though this PR no longer produces it.
  Fix direction: Align canonical contract with fbc0cc0 boundary: post-exec process output alone is generic lifecycle in M1; only trusted same-root advisory/static evidence produces `raw_data_write_denied`; otherwise a future non-forgeable OS event source is required.
  Required test/proof: Update docs/specs and run `openspec validate`; grep canonical docs for stale “process-result-visible OS denial -> denied_by_sandbox” MUST language.
  Sibling surfaces: Phased Plan, issue #19 acceptance text, backend `tool.failed` skeleton tests, audit-row consumers, prior review evidence.
  Blocking status: blocking candidate until canonical contract and implementation align.

Non-blocking notes:
- Static review only; no runtime tests rerun by reviewer.

Execution Summary: agents=review-spec-compliance; skills=review; tools=sed, rg, nl, git diff, git rev-parse, gh pr view, gh issue view; verification=static diff/spec/ADR/test review plus diff-check and zero check; limits=no runtime tests executed.
