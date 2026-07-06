Reviewer agent: `review-correctness`
Review round: round 1
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: No correctness findings; implementation matches the exact OpenSpec/issue oracle and covers the specified role/tool boundary invariants.

Invariant Matrix Coverage:
- Exact five roles only: covered - `CANONICAL_HARNESS_ROLES` contains the five canonical roles and `ROLE_TOOL_MAP` is keyed by `HarnessRole` in `packages/core/src/tools/role-tool-map.ts:3` and `packages/core/src/tools/role-tool-map.ts:45`; test coverage at `packages/core/src/tools/role-tool-map.test.ts:63`.
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered - map values match OpenSpec oracle in `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:23`; implementation at `packages/core/src/tools/role-tool-map.ts:53`; snapshot test at `packages/core/src/tools/role-tool-map.test.ts:59`.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered - snapshot helper emits only `toolIds` at `packages/core/src/tools/role-tool-map.ts:117`; subset helper uses `ROLE_TOOL_ID_SETS` built from `toolIds` at `packages/core/src/tools/role-tool-map.ts:101`; test at `packages/core/src/tools/role-tool-map.test.ts:68` and `packages/core/src/tools/role-tool-map.test.ts:102`.
- `repo_explorer` and `reviewer` contain no write-class ids: covered - role profiles at `packages/core/src/tools/role-tool-map.ts:66` and `packages/core/src/tools/role-tool-map.ts:94`; invariant test at `packages/core/src/tools/role-tool-map.test.ts:79`.
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered - coordinator profile includes both at `packages/core/src/tools/role-tool-map.ts:54`; test at `packages/core/src/tools/role-tool-map.test.ts:84`.
- `coordinator` contains no `bash`, `write`, `edit`, or `patch.apply`: covered - coordinator profile excludes them at `packages/core/src/tools/role-tool-map.ts:54`; test at `packages/core/src/tools/role-tool-map.test.ts:88`.
- `worker` contains no repository source edit ids: covered - worker profile excludes `write`, `edit`, and `patch.apply` at `packages/core/src/tools/role-tool-map.ts:70`; test at `packages/core/src/tools/role-tool-map.test.ts:93`.
- `coder` alone owns worktree edit/patch ids: covered - coder profile includes `write`, `edit`, and `patch.apply` at `packages/core/src/tools/role-tool-map.ts:87`; exclusivity test at `packages/core/src/tools/role-tool-map.test.ts:97`.
- Helper subset semantics cannot treat permission notes as ids: covered - `isRoleToolIdSubset` checks only role tool-id sets at `packages/core/src/tools/role-tool-map.ts:132`; negative note-as-id test at `packages/core/src/tools/role-tool-map.test.ts:106`.
- Removed-behavior audit: covered - diff is additive for runtime code; spec replacement clarifies capability labels into exact ids and preserves the role exclusions in `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:11`.

Findings:
- None.

Non-blocking notes:
- `Zero_Reuse_Matrix` remains frozen and does not list the new governance IDs `git.inspect`, `repo.*`, `patch.apply`, and `validator.run`; I did not treat this as a finding because the active OpenSpec fixture and issue body explicitly define those exact IDs for this PR boundary.
