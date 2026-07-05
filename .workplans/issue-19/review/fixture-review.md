# Issue #19 Fixture Review

Branch: `codex/issue-19-seatbelt-raw-deny`

## Initial fixture review

Reviewer: Schrodinger the 2nd (`019f2c99-ec4e-7c91-8c7d-a750ea6bbc0b`)

Verdict: revise

Finding:
- `nlink>1` scanning selected Resource limits / large input / discovery, but the fixture did not make bounded-root scanning testable. Required explicit protected roots, metadata-only reads under those roots, and no broader workspace/repo traversal.

Resolution:
- Updated `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md`, `openspec/changes/m1-foundation/tasks.md`, and `openspec/changes/m1-foundation/design.md` with bounded-root nlink scan expectations.

## Rerun fixture review

Reviewer: Heisenberg the 2nd (`019f2c9d-12b0-7e31-a4ef-4e28fd78e6c1`)

Verdict: pass

Findings:
- None.

Notes:
- Issue #19 remains coherent with revised 条 2' fixture.
- Bounded-root `nlink>1` contract is explicit in design/tasks/spec.
