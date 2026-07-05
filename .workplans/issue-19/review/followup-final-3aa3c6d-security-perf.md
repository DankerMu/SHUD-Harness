# Phase 6.5 Follow-up Review: Security/Performance

Reviewer agent: review-security-perf
Review round: final follow-up round after fixes
Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Summary: Runtime V1-V3 fixes look closed, but exported helper sibling surfaces still permit cwd-relative root drift.

Invariant Matrix Coverage:
- Raw byte authority: covered.
- Runtime source-of-truth identity: covered.
- Producers: missing for exported profile/audit/helper roots.
- Validators/preflight: covered.
- Storage/cache/query: covered for runtime reservation and cleanup identity.
- Public route/WS skeleton: covered for M1.
- Failure paths: covered for runtime.
- Evidence/audit/readiness: missing on exported helper sibling.
- Six escape, raw read/workspace write, hardlink residual, static advisory, and zero diff rows: covered.

Findings:
- Severity: P2, blocking under high-risk fixture unless explicitly narrowed.
  Failure class: path/evidence authority drift on exported sibling helpers
  Contract or invariant: Relative raw/evidence/workspace roots must bind to an explicit stable project root, not process cwd or per-call cwd.
  Evidence: `AppendPolicyGateAuditRowOptions` has no `pathResolutionRoot`; `appendPolicyGateAuditRow()` calls `resolve(options.workspaceRoot)`; `buildRawDataSeatbeltProfile()` and `scanProtectedHardlinks()` canonicalize relative roots via `realpath(resolve(path))`; module exports these helpers.
  Concrete scenario: A caller runs from `/tmp/runner` but appends audit/profile/hardlink evidence for `/repo` using relative roots. Helpers bind to `/tmp/runner` instead of `/repo`, or fail for the wrong root.
  Consequence: Public helper consumers can reintroduce evidence/root misbinding outside the runtime wrapper.
  Fix direction: Reject relative roots in lower-level exported helpers, or add explicit stable-base resolution with fail-closed missing-base behavior.
  Required verification: Add cwd-drift tests for audit append, profile build, and hardlink scan helper inputs.
  Sibling surfaces: runtime sandbox options, registry, future task audit writers, ingest/readiness hardlink wiring.
  Blocks merge: yes under high-risk evidence boundary.

Non-blocking notes:
- Reviewer did not run Bun/OpenSpec tests.
