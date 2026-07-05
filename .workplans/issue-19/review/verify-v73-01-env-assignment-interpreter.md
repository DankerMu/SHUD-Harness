# Verifier Verdict: V73-01-env-assignment-interpreter

Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679
Verdict: CONFIRMED
Severity: P1

Evidence: interpreter payload inspection only runs when the first effective token is itself an interpreter, and the token normalization does not unwrap leading `NAME=value` assignments or `env`. With stderr suppressed and exit normalized, hidden OS denials become successful results and the lifecycle audit records `decision=allowed`.

Disposition: merge-blocking. The fix must normalize command prefixes before interpreter detection and keep legal env-wrapped raw-read/workspace-write flows allowed.
