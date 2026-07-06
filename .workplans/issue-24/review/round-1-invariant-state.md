Reviewer agent: `review-invariant-state`
Review round: round 1
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: No P0/P1/P2 invariant-state findings; the change preserves the role/tool authority invariant with `toolIds` as the only comparable subset source.

Invariant Matrix Coverage:
- Exact five roles only: `coordinator`, `repo_explorer`, `worker`, `coder`, `reviewer`: covered - `CANONICAL_HARNESS_ROLES` defines exactly these five roles in `packages/core/src/tools/role-tool-map.ts:3`, matching `HarnessRole` in `packages/core/src/tools/policy-gate-core.ts:4` and asserted by `packages/core/src/tools/role-tool-map.test.ts:63`.
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered - OpenSpec oracle is pinned in `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:23`; implementation map is in `packages/core/src/tools/role-tool-map.ts:53`; snapshot equality and sorted-order assertions are in `packages/core/src/tools/role-tool-map.test.ts:59` and `packages/core/src/tools/role-tool-map.test.ts:68`.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered - spec excludes notes at `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:11`; snapshot copies only `.toolIds` at `packages/core/src/tools/role-tool-map.ts:117`; subset sets are built only from `.toolIds` at `packages/core/src/tools/role-tool-map.ts:101`; tests cover note exclusion at `packages/core/src/tools/role-tool-map.test.ts:74` and `packages/core/src/tools/role-tool-map.test.ts:102`.
- `repo_explorer` and `reviewer` contain no write-class ids: covered - role entries contain only read/diagnostic ids at `packages/core/src/tools/role-tool-map.ts:66` and `packages/core/src/tools/role-tool-map.ts:94`; write-class exclusion is tested at `packages/core/src/tools/role-tool-map.test.ts:79`.
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered - only coordinator includes both ids at `packages/core/src/tools/role-tool-map.ts:55`; exclusivity is tested at `packages/core/src/tools/role-tool-map.test.ts:84`.
- `coordinator` contains no `bash`, `write`, `edit`, or `patch.apply`: covered - coordinator tool list excludes those ids at `packages/core/src/tools/role-tool-map.ts:55`; test assertion is `packages/core/src/tools/role-tool-map.test.ts:88`.
- `worker` contains no repository source edit ids: `write`, `edit`, `patch.apply`: covered - worker list excludes repository source edit ids at `packages/core/src/tools/role-tool-map.ts:70`; test assertion is `packages/core/src/tools/role-tool-map.test.ts:93`.
- `coder` alone owns worktree edit/patch ids: `write`, `edit`, `patch.apply`: covered - coder list includes those ids at `packages/core/src/tools/role-tool-map.ts:87`; exclusivity is tested at `packages/core/src/tools/role-tool-map.test.ts:97`.
- Helper subset semantics cannot treat permission notes as ids: covered - `isRoleToolIdSubset` checks only the precomputed `toolIds` set at `packages/core/src/tools/role-tool-map.ts:132`; permission-note false case is tested at `packages/core/src/tools/role-tool-map.test.ts:106`.

Findings:
- None.

Non-blocking notes:
- Review was read-only; I did not rerun the full test suite, but the brief records `check`, strict OpenSpec validation, diff check, zero cleanliness, and PR CI as already passed. I did run read-only diff/status/grep/line-inspection commands and confirmed `git diff --check origin/main...HEAD` produced no output and `zero` has no diff against the PR range.
- Legacy prose examples in `docs/03_SPEC/User_Session_And_Audit_Schema.md:99` still use descriptive names like "file read/search"; I did not treat this as a finding because the reviewed issue's oracle is the updated OpenSpec exact-id table, and no changed consumer reads those examples as authority in this PR.
