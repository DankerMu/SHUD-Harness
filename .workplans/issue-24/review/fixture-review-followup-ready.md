Reviewer agent: fixture-review-followup
Issue: #24
Verdict: READY

Findings:
- None.

Notes:
- Fixture blocker is resolved. The spec and issue now define exact sorted `toolIds`, separate `permissionNotes` from spawn `allowed_tools` subset comparisons, and pin `memory(draft)` to exact id `memory`.
- Zero native names checked against source match: `spawn_agent`, `wait_agent`, `read`, `write`, `edit`, `bash`, `memory`.
- Risk tier: medium-high, because this is a capability/role boundary used by later spawn-policy checks.
- Selected Phase 4 reviewer packs: Zero adapter / tool registry / agent role governance; auth/capability boundary; schema/field-name exactness; snapshot and invariant tests.
- Implementation boundary: `packages/core` mapping constant plus snapshot/invariant tests only. Do not implement registry lint, guard_class, spawn policy logic, frozen docs edits, or Zero source changes.
