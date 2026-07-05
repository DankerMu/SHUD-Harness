# Phase 4.5 Verifier — cand-final-b246582-01-root-pid-reuse-before-first-identity

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Verifier: Euclid (`019f32a2-309d-73c1-8d68-e266f3a86940`)
Verdict: CONFIRMED

Evidence:
- `knownProcessIdentities` starts empty while only `knownPids.add(rootPid)` runs.
- `processIdentityMatchesKnown()` returns true when no known identity exists.
- Normal completion calls `terminateInvocationProcesses()` after `proc.exited`.
- Termination samples and then signals all `tracker.currentPids`.
- A first successful sample whose table contains a reused root PID can record an unrelated process as current invocation.

Merge-blocking:
- Yes. Normal cleanup can signal a non-invocation PID/process group.
