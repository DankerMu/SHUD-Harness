# Verifier verdict table -- PR #48 observable 067e544

Reviewed head SHA: `067e544368f88ec60922a243f1bcf6597f211489`

| Candidate | Verdict | Blocking input | Failure family | Rationale |
| --- | --- | --- | --- | --- |
| cand-observable-067-01 | CONFIRMED | yes | observable-denial evidence / symlink alias classification | Symlink resolver omits mutation commands (`mv`, `mkdir`, `rm`, `unlink`, `ln`) even though static raw mutation detection handles them, so visible sandbox denials can fall to generic `failed`. |
| cand-observable-067-02 | CONFIRMED | yes | evidence/audit false positive / output-only classification | Denial-like output plus syntactic raw-target analysis can be promoted to `denied_by_sandbox` even when the write branch did not execute or the real denial was hidden. |
| cand-observable-067-03 | CONFIRMED | yes | observable-denial evidence / bounded analysis fallback | Over-budget command analysis returns false before preserving visible raw-write denial evidence. |
| cand-observable-067-04 | CONFIRMED | yes | ToolResult/audit/WS profile provenance | Outer raw advisory deny can emit a profile id computed from unrelated sandbox protected roots. |

Counts:
- CONFIRMED: 4
- PLAUSIBLE: 0
- REFUTED: 0

Gate status: not clean. Return to Phase 5/6. Because this is a repeated high-risk evidence/audit boundary class on the same helper, run invariant-surface inventory and fix by class-level closure rather than isolated line fixes.
