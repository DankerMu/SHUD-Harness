# Phase 6.5 Follow-up Review: Integration

Reviewer agent: review-integration
Review round: final follow-up round after fixes
Reviewed head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc

Summary: No P0/P1 integration findings. Prior cand-3aa3-01, 03, 04, and 05 appear closed. One P2 public helper root-drift candidate remains for profile-file writing.

Invariant Matrix Coverage:
- Byte authority via seatbelt: covered.
- Trusted raw-denial telemetry: covered for public audit append, generic WS builder, reserved `denied_by_sandbox`, and outer raw-rule misconfiguration.
- Audit layout: covered for omitted audit root defaulting to `<pathResolutionRoot>/workspace`.
- Registry/spawn scoped behavior: covered.
- Remaining gap: exported `writeRawDataSeatbeltProfileFile(profile, profileRoot?)` can bind a relative override to `process.cwd()`.

Findings:
- Severity: P2
  Failure class: public helper root drift
  Contract or invariant: Public sandbox/audit helper roots must either be absolute or resolve through an explicit stable project root; relative helper roots must not silently bind to process cwd.
  Evidence: `writeRawDataSeatbeltProfileFile(profile, profileRoot?)` forwards `profileRoot`; profile file creation resolves relative paths with `resolve(path)`; raw-data-sandbox is publicly re-exported.
  Scenario: A caller builds a profile with absolute roots, changes cwd, then calls `writeRawDataSeatbeltProfileFile(profile, "workspace/profiles")`; profile artifacts land under the foreign cwd.
  Fix direction: Reject relative `profileRoot` in the profile-file writer path.
  Required verification: Cwd-drift regression for relative `profileRoot`, plus absolute `profileRoot` compatibility.
  Blocks merge: yes under high-risk public-helper closure.

Non-blocking notes:
- Reviewer could not run Bun locally.
