# Follow-up Comprehensive Review - correctness at e4f00c3

Reviewer agent: review-correctness
Review round: final comprehensive follow-up after da20028 boundary/runtime fixes
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`

Summary: Not clean. Raw byte authority is covered, but process lifecycle may still permit an un-awaited interpreter child to mutate workspace after an allowed audit row.

Invariant Matrix Coverage:
- Raw write denied by OS sandbox authority: covered. Seatbelt profile denies protected raw writes and execution goes through `sandbox-exec -f`.
- Raw read allowed under same profile: covered.
- Legal waited foreground subprocess allowed; unsafe detached/unwaited process creation fails before leak: missing for un-awaited non-session interpreter children.
- Advisory is observable/preflight only, not final byte authority: covered.
- Audit/tool.failed evidence is bounded, faithful, and not forgeable through public APIs: covered.
- Timeout/abort cleanup cannot signal unrelated host processes: covered.

Findings:
- P1 `process lifecycle / post-completion side effect containment`: `python3 -c 'import subprocess; subprocess.Popen(["sh","-c","sleep 0.2; printf leaked > workspace/unwaited-popen.txt"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)'` is not caught by session-escape or shell-background preflight, so normal completion can emit `tool.completed` / `decision=allowed` while the child writes later. Required proof: regression that fails/contains this child while preserving waited `Popen(...).wait()`.
- P2 `state-transition`: stale/deleted `protectedRawPaths` can make `canonicalizePathSet()` throw before `finalizeToolResult()`, leaving a direct `runningToolRegistry` handle non-terminal. Required proof: missing raw-root regression with terminal metadata.

Non-blocking notes:
- Reviewer did not run Bun tests. Read-only diff checks and zero pin check passed.
