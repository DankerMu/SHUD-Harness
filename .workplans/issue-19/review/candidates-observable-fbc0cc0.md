# Candidate findings -- PR #48 observable fbc0cc0

Reviewed head SHA: `fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48`

Source reports:
- `.workplans/issue-19/review/followup-observable-fbc0cc0-correctness.md`
- `.workplans/issue-19/review/followup-observable-fbc0cc0-integration.md`
- `.workplans/issue-19/review/followup-observable-fbc0cc0-security-perf.md`
- `.workplans/issue-19/review/followup-observable-fbc0cc0-test-evidence.md`
- `.workplans/issue-19/review/followup-observable-fbc0cc0-spec-compliance.md`
- `.workplans/issue-19/review/followup-observable-fbc0cc0-invariant-state.md`

## cand-observable-fbc-01 -- OpenSpec/ADR telemetry contract still describes removed post-exec `denied_by_sandbox`

Originating reviewers: integration, test-evidence, spec-compliance, invariant-state.
Severity: P1 by test-evidence/spec-compliance, P2 by integration/invariant-state.
Failure class: spec/implementation contract drift / evidence boundary mismatch.
Claim: Runtime and tests now intentionally record post-exec seatbelt denials as generic lifecycle (`allowed`/`failed`) unless the sandbox tool's own advisory/static path denies pre-exec, but active OpenSpec/design/tasks/ADR text still says process-result-visible OS denials produce remediation-shaped `raw_data_write_denied`, `tool.failed`, audit rows, and `decision=denied_by_sandbox`.
Blocking input: yes.
