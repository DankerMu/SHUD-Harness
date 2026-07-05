# Verifier verdict table — PR #48 post-gate follow-up 2689f1f

Reviewed head SHA: `2689f1f9bb82b23a86acd51418e40f8fafba3d04`

| Candidate | Verdict | Blocking input | Failure family | Rationale |
| --- | --- | --- | --- | --- |
| cand-2689-01 | CONFIRMED | yes | process lifecycle containment / audit durability | Literal process preflight plus PPID descendant sampling can miss obfuscated detached/session children; wrapper may append `tool.completed` while descendants mutate workspace/audit paths after terminal success. |
| cand-2689-02 | CONFIRMED | yes | compatibility / spec-compliance / evidence label | Over-budget legal commands are pre-denied as `raw_data_write_denied`/`denied_by_sandbox`, contrary to advisory fail-open and legal raw-read/workspace-write compatibility. |
| cand-2689-03 | CONFIRMED | yes | hidden-denial evidence / evidence-state false success | Interpreter call cap and obfuscated target recognition can miss swallowed raw write attempts; OS denial can be recorded as `tool.completed`/`allowed`. |
| cand-2689-04 | CONFIRMED | yes | compatibility false positive / process containment preflight | `hasSessionEscapeSignal()` scans raw command text, so legal workspace writes containing words like `setsid` can be rejected before sandbox execution. |

Counts:
- CONFIRMED: 4
- PLAUSIBLE: 0
- REFUTED: 0

Merge gate status: blocked. All CONFIRMED candidates map to the same post-gate invariant family: static command inference is still being used as a proxy for runtime evidence/lifecycle facts. Per post-gate budget, do not run Phase 7 or merge on this head.
