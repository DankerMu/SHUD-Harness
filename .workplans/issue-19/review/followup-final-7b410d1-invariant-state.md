# Phase 6.5 Follow-up Review: Invariant / State / Compatibility

Reviewer agent: review-invariant-state
Review round: final follow-up round after fixes
Reviewed head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc

Summary: Phase 6 fixes close the prior root-binding, public audit append, generic WS builder, protected-evidence regression, and abort fake issues. One P1 trusted-telemetry provenance candidate remains.

Invariant Matrix Coverage:
- Raw byte authority via seatbelt: covered.
- Stable project-root binding for raw/evidence/workspace/audit roots: covered.
- Public audit append rejecting raw-denial rows: covered.
- Generic WS builder rejecting raw-denial shapes: covered.
- Post-exec stdout/stderr/exit not upgraded to `denied_by_sandbox`: covered.
- Waited foreground child writing workspace: covered.
- Running/abort stale-state handling: covered.
- Outer raw-rule evaluator ownership fail-closed: covered.
- Trusted raw-denial WS provenance: partially covered; see finding.
- Compatibility/zero cleanliness: covered.

Findings:
- Severity: P1
  Failure class: trusted telemetry / provenance boundary bypass
  Contract or invariant: Raw-denial telemetry must be produced only from trusted sandbox-tool-owned advisory/static evidence; generic or caller-authored paths must not mint raw-denial PI-facing evidence.
  Evidence: Public barrels export raw-denial payload construction and WS input conversion; backend raw advisory builder validated only rule and decision.
  Scenario: A generic failure path imports core builders, creates a synthetic advisory payload, converts it, and calls the raw advisory WS builder.
  Consequence: UI/audit consumers can receive trusted-looking advisory telemetry not tied to sandbox-owned evidence.
  Fix direction: Make raw-denial WS input opaque/provenanced and accepted only from sandbox-owned evidence.
  Required verification: Hand-authored raw advisory input fails; actual sandbox advisory denial still produces accepted event input.
  Blocks merge: yes.

Non-blocking notes:
- Reviewer reported local focused tests and check passing.
