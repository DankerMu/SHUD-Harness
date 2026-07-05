# Phase 6.5 Follow-up Review: Spec Compliance

Reviewer agent: review-spec-compliance
Review round: final follow-up round after fixes
Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Summary: One P1 candidate remains. Explicit relative root fixes are covered, but omitted `auditWorkspaceRoot` still falls back to per-call `ctx.workDir`, so audit evidence can drift from the stable project workspace.

Invariant Matrix Coverage:
- Governing invariant: covered for raw byte authority.
- Source-of-truth identity/contract: missing for omitted default audit root.
- Producers: covered.
- Validators/preflight: covered.
- Storage/cache/query: missing for omitted audit root.
- Public routes/entrypoints: covered for M1 skeleton.
- Frontend/downstream consumers: out of scope.
- Failure paths/rollback/stale state: covered.
- Evidence/audit/readiness: missing for default audit root.
- Regression rows: missing for `pathResolutionRoot` + omitted `auditWorkspaceRoot` + nested `ctx.workDir`.

Findings:
- Severity: P1
  Failure class: spec compliance / audit evidence root drift
  Contract or invariant: Runtime raw/evidence/workspace roots must bind to an explicit stable project root and spike audit evidence must land under `workspace/tasks/TASK-M1-SPIKE/audit/`.
  Evidence: `reserveAuditEvidence()` passes `resolve(auditWorkspaceRoot ?? ctx.workDir)` when `auditWorkspaceRoot` is omitted. Stable-root resolver only covers explicitly provided `auditWorkspaceRoot`.
  Concrete scenario: Tool is configured with `pathResolutionRoot`, relative raw/workspace roots, and omitted `auditWorkspaceRoot`; nested workdir causes audit row under nested `workspace/nested/tasks/...`.
  Consequence: Canonical evidence readers and PR verification can miss lifecycle/advisory-denial rows.
  Fix direction: Default audit reservation root to stable project/workspace root or require explicit `auditWorkspaceRoot`.
  Required verification: Add nested-workdir omitted-audit-root regression, including registry path if needed.
  Sibling surfaces: wrapper default audit path, runtime registry callers, spawned/subagent workdirs, future full AuditEvent persistence.
  Blocks merge: yes.

Non-blocking notes:
- Prior V1/V2/V3 explicit cases appear closed.

