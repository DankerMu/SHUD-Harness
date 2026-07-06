Reviewer agent: `review-security-perf`
Review round: round 1
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: No security/performance capability-boundary findings identified for the static role->tool id map and helper surface.

Invariant Matrix Coverage:
- Exact five roles only: covered - `CANONICAL_HARNESS_ROLES` and `ROLE_TOOL_MAP` enumerate exactly `coordinator`, `repo_explorer`, `worker`, `coder`, `reviewer`; test asserts exact role set in `packages/core/src/tools/role-tool-map.test.ts:63`.
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered - OpenSpec oracle at `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:23`; implementation snapshot helper at `packages/core/src/tools/role-tool-map.ts:117`; test oracle at `packages/core/src/tools/role-tool-map.test.ts:59`.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered - snapshot copies only `.toolIds` at `packages/core/src/tools/role-tool-map.ts:122`; subset helper uses `ROLE_TOOL_ID_SETS` built from `.toolIds` at `packages/core/src/tools/role-tool-map.ts:101`; test checks no `permissionNotes` in snapshots and rejects note text at `packages/core/src/tools/role-tool-map.test.ts:68` and `packages/core/src/tools/role-tool-map.test.ts:102`.
- `repo_explorer` and `reviewer` contain no write-class ids: covered - implementation lists only read/diagnostic/validator ids at `packages/core/src/tools/role-tool-map.ts:66` and `packages/core/src/tools/role-tool-map.ts:94`; test covers write-class exclusion at `packages/core/src/tools/role-tool-map.test.ts:79`.
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered - implementation includes them only in coordinator at `packages/core/src/tools/role-tool-map.ts:54`; test checks exclusivity at `packages/core/src/tools/role-tool-map.test.ts:84`.
- `coordinator` contains no `bash`, `write`, `edit`, or `patch.apply`: covered - coordinator tool list omits those ids at `packages/core/src/tools/role-tool-map.ts:54`; test covers exclusion at `packages/core/src/tools/role-tool-map.test.ts:88`.
- `worker` contains no repository source edit ids: covered - worker includes `artifact.write` and `sandbox.exec` but omits `write`, `edit`, `patch.apply` at `packages/core/src/tools/role-tool-map.ts:70`; test covers source-edit exclusion at `packages/core/src/tools/role-tool-map.test.ts:93`.
- `coder` alone owns worktree edit/patch ids: covered - coder includes `write`, `edit`, `patch.apply` at `packages/core/src/tools/role-tool-map.ts:87`; test checks no other role contains those ids at `packages/core/src/tools/role-tool-map.test.ts:97`.
- Helper subset semantics cannot treat permission notes as ids: covered - `isRoleToolIdSubset` checks only the precomputed tool-id set at `packages/core/src/tools/role-tool-map.ts:132`; negative test uses `"memory is draft/proposal-only."` at `packages/core/src/tools/role-tool-map.test.ts:106`.

Findings:
- None.

Non-blocking notes:
- None.
