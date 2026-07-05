# Phase 6.5 Follow-up Review: Security/Performance

Reviewer agent: review-security-perf
Review round: final follow-up round after fixes
Reviewed head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc

Summary: Main Phase 6 closures are mostly in place. Two remaining candidate issues were reported on sibling/public evidence surfaces.

Invariant Matrix Coverage:
- Raw byte authority: covered.
- Stable root binding: covered for runtime, audit append, profile builder, and hardlink scan; profile-file writer override remains a gap.
- Trusted raw-denial telemetry: explicit `rule=raw-data-write` plus denied decision is blocked on public WS/audit paths; reserved raw-denial metadata via `error_id` remains a gap.
- Relative evidence/workspace/raw roots: runtime regression coverage present.
- Waited foreground child workspace write: covered.
- Resource/perf: bounded.
- Zero source invariant: clean and pinned.

Findings:
- Severity: P2
  Failure class: public helper root binding drift
  Contract or invariant: Public helper roots must not silently bind relative paths to `process.cwd()`.
  Scenario: `writeRawDataSeatbeltProfileFile(profile, "workspace/profiles")` from `/tmp/runner` writes profile artifacts under `/tmp/runner/workspace/profiles`.
  Evidence: exported profile-file writer forwards a relative root into helper code that resolves paths with `resolve(path)`.
  Fix direction: Reject relative `profileRoot`.
  Required verification: Cwd-drift test for profile-file writer.
  Blocks merge: yes under high-risk helper/root-binding surface.

- Severity: P2
  Failure class: trusted telemetry metadata smuggling
  Contract or invariant: Generic WS/audit builders must not mint raw-denial-shaped telemetry; reserved raw-denial identifiers are part of the shape.
  Scenario: Generic caller emits lifecycle `decision="failed"` but sets `error_id="raw-data-write:denied_by_sandbox:fake"` in WS or audit evidence.
  Evidence: generic guards only checked `rule` plus `decision`, while error IDs were unconstrained.
  Fix direction: Reject reserved raw-denial `error_id` prefixes from generic/public paths while allowing `raw-data-write:failed:*`.
  Required verification: WS and audit tests for reserved error ID rejection and lifecycle-positive case.
  Blocks merge: yes under trusted telemetry boundary.

Non-blocking notes:
- Reviewer could not run Bun locally.
