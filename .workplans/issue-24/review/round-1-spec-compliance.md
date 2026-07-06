Reviewer agent: `review-spec-compliance`
Review round: round 1
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: No candidate findings; PR #49 covers Issue #24 / OpenSpec task 5.1 without scope creep.

Invariant Matrix Coverage:
- OpenSpec/issue/task compliance: covered - Issue #24 targets task 5.1 role->tool_id map + snapshot/invariant tests; implementation adds `packages/core/src/tools/role-tool-map.ts`, `role-tool-map.test.ts`, exports, and check script wiring.
- Exact five roles only: covered - `CANONICAL_HARNESS_ROLES` contains exactly `coordinator`, `repo_explorer`, `worker`, `coder`, `reviewer` at `packages/core/src/tools/role-tool-map.ts:3`; test asserts exact role set at `packages/core/src/tools/role-tool-map.test.ts:63`.
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered - OpenSpec oracle is at `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:23`; implementation map is at `packages/core/src/tools/role-tool-map.ts:53`; snapshot test asserts equality at `packages/core/src/tools/role-tool-map.test.ts:59`.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered - snapshot is built only from `.toolIds` at `packages/core/src/tools/role-tool-map.ts:117`; subset uses `ROLE_TOOL_ID_SETS` from `.toolIds` only at `packages/core/src/tools/role-tool-map.ts:101`; test excludes `permissionNotes` at `packages/core/src/tools/role-tool-map.test.ts:68`.
- `repo_explorer` and `reviewer` contain no write-class ids: covered - map lines `66` and `94`; invariant test at `packages/core/src/tools/role-tool-map.test.ts:79`.
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered - coordinator map includes both at `packages/core/src/tools/role-tool-map.ts:61`; test asserts exclusivity at `packages/core/src/tools/role-tool-map.test.ts:84`.
- `coordinator` contains no `bash`, `write`, `edit`, or `patch.apply`: covered - coordinator map at `packages/core/src/tools/role-tool-map.ts:54`; test asserts exclusion at `packages/core/src/tools/role-tool-map.test.ts:88`.
- `worker` contains no repository source edit ids: covered - worker map at `packages/core/src/tools/role-tool-map.ts:70`; test asserts no `write`, `edit`, `patch.apply` at `packages/core/src/tools/role-tool-map.test.ts:93`.
- `coder` alone owns worktree edit/patch ids: covered - coder map includes `write`, `edit`, `patch.apply` at `packages/core/src/tools/role-tool-map.ts:87`; test asserts exclusivity at `packages/core/src/tools/role-tool-map.test.ts:97`.
- Helper subset semantics cannot treat permission notes as ids: covered - `isRoleToolIdSubset` checks only allowed tool id set at `packages/core/src/tools/role-tool-map.ts:132`; negative permission-note case at `packages/core/src/tools/role-tool-map.test.ts:106`.
- No registry lint / guard_class / spawn policy implementation creep: covered - diff files are limited to role map/test/export/package script plus OpenSpec/workplan clarification; task 5.2/5.3/5.4 remain separate in `openspec/changes/m1-foundation/tasks.md:45`.
- No frozen docs edits: covered - `git diff --name-status origin/main...HEAD` shows no `docs/` changes.
- No Zero source edits: covered - `git -C zero diff --quiet` returned clean; `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Acceptance criteria coverage: covered - exact five roles test at `role-tool-map.test.ts:63`; invariant tests at `role-tool-map.test.ts:79`; snapshot drift test at `role-tool-map.test.ts:59`; script included in `check` at `package.json:15`.

Findings:
- None.

Non-blocking notes:
- None.
