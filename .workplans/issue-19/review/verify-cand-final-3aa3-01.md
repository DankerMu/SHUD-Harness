# Finding Verification: cand-3aa3-01-runtime-default-audit-root

Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750
Verdict: CONFIRMED

Evidence: `resolveRawDataSandboxRuntimeRoots()` only sets `auditWorkspaceRoot` when provided, `run()` passes that possibly undefined value to `reserveAuditEvidence()`, and `reserveAuditEvidence()` falls back to `resolve(auditWorkspaceRoot ?? ctx.workDir)`. The audit helper then appends `tasks/<taskId>/audit/<file>` under that root, while the spec requires relative raw/evidence/workspace roots not drift with `ctx.workDir` and audit layout under `workspace/tasks/TASK-M1-SPIKE/audit/`.

Note: The nested `ctx.workDir=/project/workspace/subtask` scenario lands audit under `/project/workspace/subtask/tasks/TASK-M1-SPIKE/audit/`, not the canonical project workspace tree.
