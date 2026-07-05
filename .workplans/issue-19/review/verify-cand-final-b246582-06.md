# Phase 4.5 Verifier — cand-final-b246582-06-lstart-pid-identity-collision

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Verifier: Ohm (`019f32a2-7e37-7510-adc8-7a6270b9236f`)
Verdict: PLAUSIBLE

Evidence:
- `readProcessParentTable()` uses `/bin/ps -axo pid=,ppid=,lstart=`.
- Identity is the second-level `lstart` string.
- `listCurrentInvocationProcesses()` accepts a known PID when identity matches without requiring current ancestry.
- Teardown can signal `currentPids`.
- Existing tests cover identity difference, not same-second collision.

Merge-blocking:
- Yes. In high-risk review, PLAUSIBLE host process signaling of unrelated PID/process group remains blocking.
