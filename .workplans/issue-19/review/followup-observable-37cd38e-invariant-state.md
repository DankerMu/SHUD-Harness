# Review report -- invariant/state -- observable 37cd38e

Reviewer agent: review-invariant-state
Review round: observable-boundary comprehensive round
Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Summary: Not clean; raw-byte authority is strong, but one observable denial state path and one bounded-preflight invariant remain open.

Invariant Matrix Coverage:
- Six escape classes: missing for visible exit-normalized OS denials recorded as allowed.
- Legal raw read, workspace write, waited foreground subprocess: covered.
- Hardlink residual: covered.
- Static advisory: covered.
- `zero` unchanged: covered.
- Raw-byte invariant across profile/sandbox/audit: partial due observable exit-normalized denial state.
- State/lifecycle boundaries: partial; process-containment preflight scans outside command-analysis budget.
- Identity and backward compatibility: covered.

Findings:
- Severity: P1
  Failure class: evidence/audit state classification
  Contract or invariant: Observable OS-level raw denials must produce remediation-shaped tool failure, `tool.failed` payload data, and audit denial row; only hidden/suppressed denials are out of #19 telemetry scope.
  Scenario: `d=data; r=raw; p="$d/$r/visible.txt"; printf visible > "$p" || true` exposes sandbox denial on stderr while normalizing exit to 0. Raw bytes remain protected, but tool returns success and audit says allowed.
  Evidence: denial text is detected, but classifier requires `!result.success`; success flows to allowed audit append. Current regression codifies this as allowed.
  Consequence: downstream evidence can say an observable prohibited raw write was allowed.
  Fix direction: classify captured sandbox-denial output as observable when command analysis identifies a raw write target, regardless of final exit status; keep no-output/suppressed exit-0 out of scope.
  Required test/proof: visible stderr plus `|| true`/`; true` raw writes assert `raw_data_write_denied`, `decision=denied_by_sandbox`, remediation, and audit identity; retain suppressed-stderr and legal raw-read positives.
  Sibling surfaces: masked redirection failures, child-shell masked failures, tools printing denial but exiting 0, interpreter helpers exposing stderr while normalizing status.
  Blocks merge: yes, candidate P1.

- Severity: P2
  Failure class: resource limit / preflight boundedness
  Contract or invariant: Pre-exec analysis must be bounded; narrowed process-creation preflight should not scan full command/payload outside budget.
  Scenario: multi-megabyte `python3 -c '<payload>'` reaches process preflight after advisory fail-open; preflight scans/strips entire command and payload before sandbox timeout.
  Evidence: advisory budget exists, but process preflight does not use it; `hasSessionEscapeSignal`, `stripInterpreterLiteralAndCommentText`, and `hasUnwaitedBackgroundExecution` scan raw command/payload.
  Consequence: adversarial input can consume CPU/memory before sandboxed process starts.
  Fix direction: apply a dedicated budget to process-containment preflight, reusing command length/segment/payload limits or cheaper containment-only cap; fail open or return bounded containment-unavailable consistently with observable-boundary decision.
  Required test/proof: over-budget preflight regression proving prompt return and no unbounded segment/payload scans, while waited foreground child remains allowed.
  Sibling surfaces: session/background scanners, nested `sh -c`/interpreter payload handling, future executor containment scanners.
  Blocks merge: non-blocking P2, fix or explicitly defer.

Non-blocking notes:
- None.
