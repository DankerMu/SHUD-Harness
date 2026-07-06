Reviewer agent: `review-integration`
Review round: round 1
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: No P0/P1/P2 findings; the PR preserves the exact `toolIds` oracle and keeps `permissionNotes` out of comparable/subset semantics.

Invariant Matrix Coverage:
- Exact five roles only: covered - `CANONICAL_HARNESS_ROLES` contains only `coordinator`, `repo_explorer`, `worker`, `coder`, `reviewer`, and the test asserts no extra/missing `ROLE_TOOL_MAP` keys (`packages/core/src/tools/role-tool-map.ts:3`, `packages/core/src/tools/role-tool-map.test.ts:63`).
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered - implementation matches the oracle in spec lines 23-32 and test lines 59-60; sorted-order assertion is at test lines 68-76.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered - snapshots copy only `ROLE_TOOL_MAP[role].toolIds`; tests assert no `permissionNotes` property and reject a note string as an allowed id (`packages/core/src/tools/role-tool-map.ts:117`, `packages/core/src/tools/role-tool-map.test.ts:68`, `packages/core/src/tools/role-tool-map.test.ts:102`).
- `repo_explorer` and `reviewer` contain no write-class ids: covered - map entries contain read-only ids only, and tests intersect them with `write`, `edit`, `patch.apply`, `artifact.write`, `sandbox.exec`, `bash` (`packages/core/src/tools/role-tool-map.ts:66`, `packages/core/src/tools/role-tool-map.ts:94`, `packages/core/src/tools/role-tool-map.test.ts:46`, `packages/core/src/tools/role-tool-map.test.ts:79`).
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered - only coordinator lists those ids, and test `rolesContainingAny(SPAWN_TOOL_IDS)` expects `["coordinator"]` (`packages/core/src/tools/role-tool-map.ts:53`, `packages/core/src/tools/role-tool-map.test.ts:84`).
- `coordinator` contains no `bash`, `write`, `edit`, or `patch.apply`: covered - coordinator profile excludes those ids, matching ADR/spec conflict resolution; test asserts empty intersection (`packages/core/src/tools/role-tool-map.ts:53`, `packages/core/src/tools/role-tool-map.test.ts:88`, `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:35`).
- `worker` contains no repository source edit ids: covered - worker includes `sandbox.exec`/`artifact.write` but excludes `write`, `edit`, `patch.apply`; test asserts the repository-source-edit intersection is empty (`packages/core/src/tools/role-tool-map.ts:70`, `packages/core/src/tools/role-tool-map.test.ts:93`).
- `coder` alone owns worktree edit/patch ids: covered - coder includes `write`, `edit`, `patch.apply`, and tests assert no other role contains those ids (`packages/core/src/tools/role-tool-map.ts:87`, `packages/core/src/tools/role-tool-map.test.ts:97`).
- Helper subset semantics cannot treat permission notes as ids: covered - `isRoleToolIdSubset` checks against precomputed `toolIds` sets only, and the negative test rejects `"memory is draft/proposal-only."` (`packages/core/src/tools/role-tool-map.ts:101`, `packages/core/src/tools/role-tool-map.ts:132`, `packages/core/src/tools/role-tool-map.test.ts:102`).

Findings:
- None.

Non-blocking notes:
- None.
