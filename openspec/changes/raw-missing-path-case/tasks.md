# Tasks

## 1. Shared raw path identity

- [x] 1.1 Add a public-decision tracer for absent fixed-output case aliases and observe semantic RED before production changes; preserve the original 142 test-file oracle and native baseline controls. Parent observed 4 semantic failures and 3 controls passing (artifact1948); native two-volume baseline separately failed the three insensitive aliases while sensitive counterparts passed.
- [x] 1.2 Implement the single raw-owner identity correction with confirmed-sensitive, confirmed-insensitive and unknown outcomes, bounded read-only evidence and PI-approved unknown denial; verify three fixed outputs, both native filesystem modes, mount boundary, empty/unusable evidence, symlink/hardlink ambiguity, original traversal and sibling controls. Focused 1091 passed/1 skipped; native insensitive/sensitive controls and the mounted APFSX boundary passed.
- [x] 1.3 Add public boundary coverage of shared canonical consumers and actual pre-execute/ToolRuntime refusal with zero execute/approval/filesystem mutation; preserve shell-text/provenance/target-set semantics and verify fresh decisions and resource release. Keep implementation and behavior documentation together. Twelve independent built ToolRuntime controls passed across both native modes; backend was a fail-fast double, not solver evidence.

## 2. Integration and delivery

- [x] 2.1 Parent verifies build, targeted tests, pnpm run check, openspec strict validation, profile smoke, actual native two-volume controls and raw-guard T1–T5 with unchanged raw hashes; retain commands, outputs and limits in PR evidence. Final check: 145 files, 4832 passed/2 skipped, coverage statements 87.58%/branches 87.20%/functions 93.41%/lines 88.87%, duplication 0.50%; strict/profile and all five live probes passed.
- [ ] 2.2 Complete expanded fixture review before implementation and three-seat final white-box review plus exact-head CI before merge; synchronize/archive this independent raw identity delta only, leaving M3 PI acceptance untouched.

## Risk / evidence map

- Public API/entry: selected, public decideRawAccess and actual ToolRuntime/pre-execute assertions; no exported signature change.
- Config/project setup: not selected, no option/default or installer change.
- File IO/path safety/overwrite: selected, both native sensitivities and mount-root control, immutable snapshots, alias/symlink/parent/sibling matrix, no product probe files.
- Schema/columns/units: not selected, no persisted data change.
- Auth/permissions/secrets: selected, raw deny before execute/approval; unknown cannot become provenance ask; controlled errors and existing audit payload only.
- Concurrency/shared state/ordering: selected only for per-call fresh evidence and lookup-race uncertainty; no new lifecycle or stronger TOCTOU guarantee.
- Resource limits/discovery: selected, bounded directory metadata inspection and deterministic handle release; no raw content reads or unbounded tree scan.
- Legacy compatibility: selected, old142 test oracle, shell canonical text/lexical case probe and error propagation preserved; native existing aliases and same-case controls.
- Error handling/partial outputs: selected, primary existing path errors unchanged, probe faults/unusable evidence fail closed only for plausible collision, zero outputs.
- Release/dependency compatibility: not selected, no dependency/build format change.
- Documentation: selected, new raw identity requirement and PI comment6544516557 explicitly qualify uncertain sensitive-directory behavior; no parallel policy owner.

Reviewer seats: correctness; test-evidence+spec-compliance; security-perf/invariant path review. Fix passes are mechanically bounded. No tests/build/lint/format commands in leaf agents; parent owns execution evidence.
