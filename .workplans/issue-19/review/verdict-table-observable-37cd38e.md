# Verifier verdict table -- PR #48 observable 37cd38e

Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

| Candidate | Verdict | Blocking input | Failure family | Rationale |
| --- | --- | --- | --- | --- |
| cand-observable-37-01 | CONFIRMED | yes | observable-denial evidence / symlink alias | Visible symlink-only raw alias denial lacks lexical raw target and can fall through to generic failure. |
| cand-observable-37-02 | CONFIRMED | yes | wrapper / policy-gate deny bypass | Outer `raw-data-write` deny delegates back into inner sandbox execution. |
| cand-observable-37-03 | CONFIRMED | yes | evidence/audit contract / over-budget false denial | Over-budget failed output matching `Permission denied` can become `raw_data_write_denied` without raw-write target proof. |
| cand-observable-37-04 | CONFIRMED | yes | evidence/audit state classification | Visible sandbox denial plus `|| true` exits 0 and is recorded as allowed. |
| cand-observable-37-05 | CONFIRMED | yes | test-evidence / CI skip gating | Linux/non-seatbelt CI fails because runtime sandbox cases use plain `test(...)` instead of skip-gated helpers. |
| cand-observable-37-06 | CONFIRMED | no | wrapper/proxy faithfulness | Exported `innerTool` option drops wrapped BashTool fuse/lifecycle semantics. |
| cand-observable-37-07 | CONFIRMED | no | resource/performance | Descendant tracker can spawn `/bin/ps` every 20ms and output buffering is unbounded. |
| cand-observable-37-08 | CONFIRMED | no | resource / preflight boundedness | Process-containment preflight scans command/payload outside command-analysis budget. |

Counts:
- CONFIRMED: 8
- PLAUSIBLE: 0
- REFUTED: 0

Gate status: not clean. Return to Phase 5/6 with class-level fixes before another comprehensive review.
