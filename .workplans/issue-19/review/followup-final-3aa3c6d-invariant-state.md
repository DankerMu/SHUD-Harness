# Phase 6.5 Follow-up Review: Invariant / State / Compatibility

Reviewer agent: review-invariant-state
Review round: final follow-up round after fixes
Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Summary: Two P1 invariant/evidence-boundary candidates remain. Prior explicit-root and cleanup substitutions appear addressed, but sibling root/evidence surfaces remain open.

Invariant Matrix Coverage:
- Raw byte authority: covered.
- Trusted raw-denial telemetry boundary: missing for public audit/WS surfaces.
- Stable project-root binding: missing for implicit audit fallback and public append/helper relative roots.
- Post-exec stdout/stderr/exit not upgraded to sandbox denial: covered.
- Legal waited foreground child process: covered.
- Cleanup identity: covered.
- Outer raw-rule evaluator ownership: covered.
- Audit storage/layout: partially covered.
- Backward compatibility: covered.
- Hardlink/resource-bound residual: covered.

Findings:
- Severity: P1
  Failure class: evidence root binding / stale-state boundary
  Contract or invariant: Relative raw/evidence/workspace roots must bind to an explicit stable project root and must not drift with agent cwd or per-call `ctx.workDir`.
  Evidence: `reserveAuditEvidence()` falls back to `ctx.workDir` when `auditWorkspaceRoot` is omitted. Public `appendPolicyGateAuditRow()` resolves `workspaceRoot` with process cwd and has no `pathResolutionRoot` or absolute-path guard.
  Concrete scenario: Stable project runtime omits `auditWorkspaceRoot` and a scoped bash call runs under nested workdir; audit rows land under the nested task tree. Separately, public append with relative workspace root binds to process cwd.
  Consequence: Evidence can be written to the wrong audit tree.
  Fix direction: Default audit reservation to stable `pathResolutionRoot` when present, or fail closed unless explicit absolute audit root is supplied; add stable-base or absolute-only validation for public append/helper surfaces.
  Required verification: Tests for omitted audit root with nested `ctx.workDir`; public relative workspace root without stable base fails closed; absolute roots remain compatible.
  Blocks merge: yes.

- Severity: P1
  Failure class: trusted telemetry / evidence-boundary bypass
  Contract or invariant: Raw-denial telemetry is limited to trusted sandbox-tool-owned advisory/static same-root evidence; outer or post-exec sources must not fabricate raw profile/audit/WS evidence.
  Evidence: Public audit append rejects only `denied_by_sandbox` and allows `raw-data-write` + `denied_by_advisory`; generic WS builder accepts arbitrary `rule`/`decision`.
  Concrete scenario: Generic failure handler sees post-exec stderr and calls public audit/WS builders with raw-denial decisions, creating PI-facing raw-denial telemetry that did not pass through the sandbox-owned converter.
  Consequence: Downstream evidence cannot distinguish trusted raw-denial telemetry from caller-minted rows/events.
  Fix direction: Reject all raw-denial decisions from public append paths unless they come through trusted internal reservation/converter. Constrain WS raw-denial emission to trusted converter output; keep `denied_by_sandbox` disabled until real OS event source.
  Required verification: Public append rejects `denied_by_advisory` and `denied_by_sandbox` raw rows; generic lifecycle rows still append; WS generic builder cannot emit raw denial shapes.
  Blocks merge: yes.

Non-blocking notes:
- Reviewer remained read-only.
