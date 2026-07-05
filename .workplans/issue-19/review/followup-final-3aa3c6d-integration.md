# Phase 6.5 Follow-up Review: Integration

Reviewer agent: review-integration
Review round: final follow-up round after fixes
Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Summary: One integration candidate remains. Explicit relative roots are fixed, but implicit audit-root fallback still binds evidence to per-call `ctx.workDir`.

Invariant Matrix Coverage:
- Governing invariant: covered for raw byte authority; zero remains pinned.
- Source-of-truth identity/contract: missing for default audit evidence root.
- Producers: covered for sandbox/profile helper, wrapper, advisory rule, registry, and WS skeleton.
- Validators/preflight: covered by relative-root, cleanup, advisory, audit-safety, process-containment, and raw-byte tests.
- Storage/cache/query: missing for omitted `auditWorkspaceRoot`.
- Public routes/entrypoints: out of scope for full WS route; M1 skeleton only.
- Frontend/downstream consumers: covered for envelope/payload shape only.
- Failure paths/rollback/stale state: covered for prior findings.
- Evidence/audit/readiness: missing when callers omit explicit audit root.
- Regression rows: covered except implicit audit-root fallback with stable `pathResolutionRoot` and nested workdir.

Findings:
- Severity: P1
  Failure class: integration contract / evidence root identity drift
  Contract or invariant: Relative raw/evidence/workspace roots and policy-gate evidence must bind to one explicit stable project/workspace identity; spike audit rows belong under `workspace/tasks/TASK-M1-SPIKE/audit/`, not caller/subagent workdirs.
  Evidence: `reserveAuditEvidence()` still uses `resolve(auditWorkspaceRoot ?? ctx.workDir)`. Zero session and spawn agents create nested workdirs.
  Concrete scenario: Runtime uses stable `pathResolutionRoot` and relative raw/write/profile roots, but omits `auditWorkspaceRoot`. A Zero session or spawned subagent invokes bash from a nested workdir; raw authority uses stable project root, but audit rows are written under the caller workdir's `tasks/` tree.
  Consequence: Downstream audit/receipt consumers can miss or split evidence for the same profile/run.
  Fix direction: Derive default audit workspace from stable `pathResolutionRoot`, or require explicit stable `auditWorkspaceRoot`.
  Required verification: Add nested-workdir regression for omitted audit root and stable `pathResolutionRoot`.
  Sibling surfaces: `createShudSandboxedBashTool`, `createShudRuntimeToolRegistry`, spawn scoped registries, audit readers.
  Blocks merge: yes.

Non-blocking notes:
- Reviewer remained read-only.

