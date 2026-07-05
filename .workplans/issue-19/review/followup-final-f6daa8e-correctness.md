# Final follow-up review -- correctness

Reviewed head SHA: `f6daa8ee6af061097a2407c35593def8a873f600`
PR: `#48`
Issue: `#19`

## Summary

Correctness review is not clean.

## Candidate findings

- C1 / P1: interpreter process-containment analysis strips `//` as a comment for Python payloads, allowing `0//1; os.setsid()` to hide a static session escape from preflight.
- C2 / P2: `start_new_session=True` is rejected even when it is only a benign variable assignment, not a subprocess argument.
- C3 / P2: `(wait)` and `wait | cat` are treated as satisfying a parent-shell background job even though bash does not wait for that job in those forms.
- C4 / P2: public `appendPolicyGateAuditRow()` can still append `decision: "denied_by_sandbox"` for `rule: "raw-data-write"`, bypassing the reserved evidence boundary.

## Gate recommendation

Blocked pending verifier gate.
