# Phase 4.5 Verifier — cand-final-bbae63f-06-descendant-pid-reuse

Reviewed head SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Verifier: Mendel (`019f3283-329d-7732-ac09-ab2f226bbac2`)
Verdict: PLAUSIBLE

Evidence:
- Normal completion calls `terminateInvocationProcesses`.
- Tracker state is historical numeric PID set only.
- Teardown kills every stored PID and process group without validating current PID identity.
- A legal waited child can be sampled and reaped before the parent command exits, leaving a stale PID in the set.

Merge-blocking:
- Yes under the current fixture policy. The race is rare but realistic and the failure mode is destructive host-process kill outside the invocation.
