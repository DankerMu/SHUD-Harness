# review-integration

Review round: post-gate follow-up after fixes
Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679

Summary: Not clean; the follow-up closes several prior blockers, but target recognition and downstream running-state integration still have actionable gaps.

Invariant Matrix Coverage:
- Governing invariant: missing - hidden interpreter receiver/named-mode mutations can still be reported allowed.
- Source-of-truth identity/contract: covered - raw denial payload/audit row retain rule, decision, remediation, profile id, and policy ref.
- Producers: missing - the subprocess runner finalizes `RunningToolHandle` before outer denial/audit normalization.
- Validators/preflight: missing - tests do not cover receiver mutations such as `Path(...).unlink()` or named write modes.
- Storage/cache/query: covered - audit reservation supports project-root fixtures and canonical workspace roots with identity checks.
- Public entrypoints: covered - wrapper entrypoint remains the bash tool `run()` path.
- Frontend/downstream consumers: missing - Zero/session running-tool metadata can remain stale after the wrapper returns a different final result.
- Evidence/audit/readiness: covered for lifecycle append failures.

Findings:
- P1 / hidden interpreter mutation false negative: `Path("data/raw/input.csv").unlink()`, `Path(...).rename(...)`, and `open("data/raw/x.csv", mode="w")` are not recognized by the suppressed-denial guard. Consequence: OS-denied raw mutations can return success/evidence as allowed. Required verification: suppressed-runtime tests proving `denied_by_sandbox`, no raw mutation, and matching audit rows.
- P1 / downstream state contract mismatch: `runSeatbeltSandboxedBash()` marks the running handle completed after subprocess exit, while outer raw-denial normalization and lifecycle audit fail-closed happen later. Zero's `SessionRunningToolHandle.markFinished()` refuses later updates, so Session Detail can show success when the final ToolResult is `policy_gate_audit_unavailable` or `denied_by_sandbox`. Required verification: registry-backed tests for audit append failure, visible sandbox denial, and successful allowed command.
- P2 / cwd-dependent false raw-denial classification: parent-relative classification infers initial cwd from protected raw paths rather than actual `ctx.workDir`, which can pre-deny legal workspace-local `data/raw` writes when runtime cwd is canonical workspace root.

Non-blocking notes:
- Read-only checks reported by reviewer: zero clean and `git diff --check` passed.
