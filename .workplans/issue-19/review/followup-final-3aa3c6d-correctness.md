# Phase 6.5 Follow-up Review: Correctness

Reviewer agent: review-correctness
Review round: final follow-up round after fixes
Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Summary: One correctness candidate remains. Explicit relative roots and cleanup identity fixes are covered, but omitted `auditWorkspaceRoot` still binds audit evidence to per-call `ctx.workDir` instead of the stable project/workspace root.

Invariant Matrix Coverage:
- Raw byte authority: covered by seatbelt execution and six escape-class byte-preservation tests.
- Stable relative root binding: partially covered. Explicit `protectedRawPaths` and explicit `auditWorkspaceRoot` use `pathResolutionRoot`; missing stable base fails closed. Omitted `auditWorkspaceRoot` remains uncovered and appears wrong.
- Trusted raw-denial telemetry boundary: covered for sandbox-owned advisory evidence and generic post-exec lifecycle failures.
- Outer raw-rule ownership: covered; outer `RAW_DATA_WRITE_RULE_ID` evaluator returns misconfiguration.
- Registry/spawn runtime path: covered; runtime registry replaces bash and rebuilds scoped spawn registry.
- Process containment and waited foreground child: covered for M1 boundary.
- Audit path safety/overwrite: covered for explicit workspace roots.
- Profile cleanup identity: covered.
- Hardlink residual scan: covered.
- WS skeleton evidence shape: covered.
- Documentation/migration notes: covered.

Findings:
- Severity: P1
  Failure class: evidence/audit root binding
  Contract or invariant: Runtime raw/evidence/workspace roots must bind to an explicit stable project root, not agent cwd or per-call `ctx.workDir`; every sandboxed bash invocation must write lifecycle audit rows to the canonical workspace/task audit surface.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts` resolves `auditWorkspaceRoot` only when explicitly provided, then `reserveAuditEvidence()` falls back to `resolve(auditWorkspaceRoot ?? ctx.workDir)`. Zero spawn agents derive nested sub-workdirs.
  Concrete scenario: `createShudRuntimeToolRegistry` is configured with stable `pathResolutionRoot` and absolute or resolved raw/workspace roots, but omits `auditWorkspaceRoot`. A spawned subagent runs bash with `ctx.workDir=<project>/workspace/subagents/<id>`; audit rows land under `<project>/workspace/subagents/<id>/tasks/TASK-M1-SPIKE/audit/` instead of `<project>/workspace/tasks/TASK-M1-SPIKE/audit/`.
  Consequence: Raw bytes remain protected, but lifecycle/denial audit evidence fragments by invocation cwd and can be missed by canonical audit readers.
  Fix direction: When `auditWorkspaceRoot` is omitted, bind audit root to the same stable base as other runtime roots, or fail closed unless an explicit stable audit root is configured.
  Required verification: Add omitted `auditWorkspaceRoot` + `pathResolutionRoot` + nested `ctx.workDir` regression and assert canonical audit placement.
  Sibling surfaces: `RawDataSandboxedBashTool.reserveAuditEvidence`, runtime registry defaults, spawn scoped registries, direct callers, public audit append docs.
  Blocks merge: yes.

Non-blocking notes:
- Prior explicit-root V1/V2 and cleanup V3 fixes appear closed.
- Reviewer did not run Bun tests; orchestrator local `bun run check` passed separately.

