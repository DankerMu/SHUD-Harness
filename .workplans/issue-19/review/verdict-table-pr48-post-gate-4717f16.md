# Verifier verdict table — PR #48 post-gate follow-up 4717f16

Reviewed head SHA: `4717f1608058418a279365b385afc17e35e2238a`

| Candidate | Verdict | Blocking input | Failure family | Rationale |
| --- | --- | --- | --- | --- |
| cand-4717-01 | CONFIRMED | yes | hidden-denial evidence / symlink alias false success | Workspace symlink-to-raw hidden write can be denied by seatbelt while static target recognition misses the alias and records `tool.completed/allowed`. |
| cand-4717-02 | CONFIRMED | yes | process lifecycle containment / stale descendant mutation | Obfuscated Python `getattr(os,"fork")` + computed `setsid` bypasses preflight and PPID sampling can miss reparented descendants. |
| cand-4717-03 | CONFIRMED | yes | hidden-denial evidence / over-budget false allowed | Over-budget hidden raw writes can hide stderr/exit and reach success audit path because budget overflow discards target evidence. |
| cand-4717-04 | CONFIRMED | yes | compatibility false positive / waited child process | Broad `subprocess.Popen(` preflight denies a waited foreground workspace write, violating legal workspace-write compatibility. |

Counts:
- CONFIRMED: 4
- PLAUSIBLE: 0
- REFUTED: 0

Gate status: blocked. The allowed post-gate comprehensive review after the `2689f1f` strategy action still reports P1 findings in the same invariant family: the wrapper is trying to infer runtime mutation/evidence/process facts from shell/program text. Do not run Phase 7 or merge on this head.
