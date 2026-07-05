Reviewer agent: review-correctness
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 8bbfd68eb474e9d27386fe13a05fb1b549bb5198

Summary: No P0/P1/P2 correctness findings; the final head preserves raw byte authority and narrows telemetry to trusted sandbox-owned evidence.

Invariant Matrix Coverage:
- Central policy-gate wrapper: covered - registry wrapping, rewrapping, unwrapped-tool failure, and spawn-scoped registry inheritance are implemented in `policy-gate-registry.ts` and covered in `policy-gate-registry.test.ts`.
- Raw byte authority for six escape classes: covered - seatbelt profile denies raw writes at execution time, including interpreter payloads, pipeline/stdin, dynamic targets, child processes, symlink/`../`, rename/unlink, hidden/suppressed failures, and over-budget commands.
- Legal raw read and workspace write compatibility: covered - raw reads, raw-to-workspace copies, workspace writes, and waited foreground child process writes remain allowed.
- Advisory fail-open and trusted denial path: covered - static advisory can pre-deny obvious same-root raw writes with remediation/audit evidence, while uncertainty and post-exec process output remain lifecycle evidence only.
- No post-exec raw-denial promotion: covered - process stdout/stderr/exit status no longer become `raw_data_write_denied` or `denied_by_sandbox`; lifecycle rows use `allowed|failed`.
- Raw-denial ownership boundary: covered - outer `RAW_DATA_WRITE_RULE_ID` evaluator denials fail closed as configuration misuse, and public audit/WS builders reject reserved raw-denial rows or error IDs.
- Trusted WS raw advisory evidence: covered - raw advisory `tool.failed` now requires sandbox-owned proof obtained from the actual `ToolResult` path; structural caller-authored payloads are rejected.
- Audit path safety and canonical placement: covered - audit reservation rejects raw/symlink/hardlink/stale targets, protects audit ancestors under the profile, and resolves project-root fixtures to canonical `workspace/tasks/.../audit`.
- Stable root binding: covered - relative raw/evidence/profile/audit roots require `pathResolutionRoot`; omitted audit root defaults to stable `<pathResolutionRoot>/workspace`; public profile writer rejects relative `profileRoot`.
- Process containment boundary: covered - known session/process-group escape forms are rejected, top-level waited background patterns are distinguished, and legal waited foreground subprocesses remain allowed.
- Hardlink residual handling: covered - pre-existing hardlink alias remains documented as residual, with bounded `nlink>1` protected-root scanning evidence.
- Zero source compatibility: covered - implementation is in SHUD-side wrappers/tools; user-provided verification confirms `git -C zero diff --quiet` and zero HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Documentation/OpenSpec alignment: covered - ADR, Phased Plan, and policy-gate-spike spec now match the trusted-observable telemetry boundary and deferred hidden-denial/process-ownership scope.

Findings:
- None.

Non-blocking notes:
- None.
