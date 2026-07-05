# Review report -- spec compliance -- observable 37cd38e

Reviewer agent: review-spec-compliance
Review round: observable-boundary comprehensive round
Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Summary: No candidate P0/P1/P2 spec-compliance findings found against the observable-boundary contract.

Invariant Matrix Coverage:
- Six escape classes targeting `data/raw/**`: covered. Seatbelt profile denies protected raw literals/subpaths and tests cover the six negative classes.
- Observable denial telemetry only: covered. Visible sandbox denials map to remediation payload/audit rows; hidden/suppressed telemetry is explicitly out of scope and covered by no-false-telemetry tests.
- Legal raw read, workspace write, waited foreground subprocess: covered.
- Pre-existing hardlink residual: covered by bounded explicit-root `nlink>1` scan and residual demonstration.
- Static advisory: covered, including fail-open uncertainty and legal raw read allow.
- WebSocket event type boundary: covered; no new policy-denial event type found.
- `zero` source unchanged: covered; local review observed HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` and clean diff.

Findings:
- None.

Non-blocking notes:
- Full WebSocket session routing remains deferred; the M1 `tool.failed` builder/envelope matches the intended skeleton depth.
