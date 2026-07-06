Reviewer agent: fixture-review-followup
Issue: #24
Verdict: READY

Supersession note:
- This fixture review was produced before the Phase 7 raw Zero `memory` finding and Phase 6 closure. Its exact-id memory note below is superseded by PR #49 head `8e028e5ea1c93e3852aebc2e2714d32834583099` and the live Issue #24/OpenSpec oracle: M1 comparable `toolIds` use `harness.memory.propose`; raw Zero `memory` is explicitly excluded.

Findings:
- None.

Notes:
- Fixture blocker is resolved. The spec and issue define exact sorted `toolIds` and separate `permissionNotes` from spawn `allowed_tools` subset comparisons. Phase 6 supersedes the original draft-memory id decision: `harness.memory.propose` is the proposal-only placeholder, and raw Zero `memory` is not an M1 comparable role `toolId`.
- Zero native names checked against source for M1 comparable raw Zero ids match: `spawn_agent`, `wait_agent`, `read`, `write`, `edit`, `bash`. Raw Zero `memory` remains a Zero native tool but is intentionally excluded from this role map.
- Risk tier: medium-high, because this is a capability/role boundary used by later spawn-policy checks.
- Selected Phase 4 reviewer packs: Zero adapter / tool registry / agent role governance; auth/capability boundary; schema/field-name exactness; snapshot and invariant tests.
- Implementation boundary: `packages/core` mapping constant plus snapshot/invariant tests only. Do not implement registry lint, guard_class, spawn policy logic, frozen docs edits, or Zero source changes.
