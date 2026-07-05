# Review report -- PR #48 observable fbc0cc0 correctness

Reviewer agent: review-correctness
Review round: follow-up observable fbc0cc0
Reviewed head SHA: fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48

Summary:
No correctness findings; the follow-up removes unsafe output-based attribution and keeps byte authority in the seatbelt sandbox.

Invariant Matrix Coverage:
- Raw byte authority: covered - bash still runs through `/usr/bin/sandbox-exec -f <profile> /bin/bash -c` with protected raw paths in the generated profile.
- Removed post-exec output upgrade: covered - no residual `isLikelySandboxDenialForCommand` / target attribution helpers remain, and post-run results append generic `allowed` / `failed` lifecycle rows.
- Forged-output regressions: covered - target-qualified, basename-only, same-basename workspace permission, and over-budget forged denial cases assert no `raw_data_write_denied` and no `denied_by_sandbox` audit row.
- Outer raw-rule provenance: covered - outer policy denies return generic `policy_gate_denied` without sandbox profile identity or audit rows.
- Advisory ownership boundary: covered - obvious static raw writes are handled only by the sandbox tool's own advisory path, where it owns the protected roots and profile/audit context.
- Audit factuality: covered - generic lifecycle helper asserts hidden/suppressed/ambiguous denials do not claim sandbox-denial telemetry.
- WS/ErrorRecord skeleton: covered.
- Zero unchanged: covered at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Hidden OS-denial telemetry backend: out-of-scope.

Findings:
None.

Non-blocking notes:
- Bun tests were not rerun by this reviewer; static checks included diff/context review, removed-helper search, `git diff --check`, and zero verification.

Execution Summary: agents=review-correctness; skills=review; tools=sed,nl,rg,git diff,git diff --check,git rev-parse,git status,git -C zero; verification=static PR review plus diff-check and zero clean/pin check; limits=read-only review, no tests rerun.
