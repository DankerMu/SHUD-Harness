Reviewer agent: `review-test-evidence`
Review round: round 1
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: No candidate P0/P1/P2 test-evidence findings; issue #24 task/AC/scenario coverage is backed by role-tool-map tests, fresh CI, and read-only git/gh evidence.

Invariant Matrix Coverage:
- Issue task: mapping table constant in `packages/core`: covered - `packages/core/src/tools/role-tool-map.ts:3` and `:53`; exported through `packages/core/src/tools/index.ts:42`.
- Issue task: exact sorted `toolIds` snapshot: covered - oracle in `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:23`; expected snapshot in `packages/core/src/tools/role-tool-map.test.ts:21`; assertion at `:59`.
- Issue task: 4+ invariant tests: covered - five direct invariant tests at `packages/core/src/tools/role-tool-map.test.ts:79`, `:84`, `:88`, `:93`, `:97`.
- Issue task: naming decision / no hyphen tool ids / `memory` exact id: covered - implementation ids at `packages/core/src/tools/role-tool-map.ts:13`; map values at `:53`; snapshot oracle test at `packages/core/src/tools/role-tool-map.test.ts:59`.
- Issue AC: exactly five canonical roles: covered - `packages/core/src/tools/role-tool-map.test.ts:63`; source type anchor `packages/core/src/tools/policy-gate-core.ts:4`.
- Issue AC: invariant tests pass: covered - CI log shows `role-tool-map.test.ts` ran with `9 pass, 0 fail` on 2026-07-05T18:47:23Z.
- Issue AC: map drift without snapshot update fails: covered - `createRoleToolIdsSnapshot()` is compared to independent expected oracle at `packages/core/src/tools/role-tool-map.test.ts:59`.
- Spec scenarios outside #24 (`注册期 lint`, `guard_class`, spawn depth/concurrency): out-of-scope - issue body excludes them; tasks remain 5.2-5.4 in `openspec/changes/m1-foundation/tasks.md:45`.
- Exact five roles only: covered - `CANONICAL_HARNESS_ROLES` and `ROLE_TOOL_MAP` keys asserted at `packages/core/src/tools/role-tool-map.test.ts:63`.
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered - `packages/core/src/tools/role-tool-map.test.ts:59` plus sorted check at `:68`.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered - snapshot property exclusion at `packages/core/src/tools/role-tool-map.test.ts:74`; subset negative at `:106`.
- `repo_explorer` and `reviewer` contain no write-class ids: covered - `packages/core/src/tools/role-tool-map.test.ts:79`.
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered - `packages/core/src/tools/role-tool-map.test.ts:84`.
- `coordinator` contains no `bash`, `write`, `edit`, or `patch.apply`: covered - `packages/core/src/tools/role-tool-map.test.ts:88`.
- `worker` contains no repository source edit ids: covered - `packages/core/src/tools/role-tool-map.test.ts:93`.
- `coder` alone owns worktree edit/patch ids: covered - `packages/core/src/tools/role-tool-map.test.ts:97`.
- Helper subset semantics cannot treat permission notes as ids: covered - `isRoleToolIdSubset` uses `ROLE_TOOL_ID_SETS` from `toolIds` only at `packages/core/src/tools/role-tool-map.ts:101`; test at `packages/core/src/tools/role-tool-map.test.ts:102`.
- Local and CI evidence freshness: covered - local HEAD matches brief SHA; `gh run view` shows CI run `28751130811` on head SHA `bb40d927edff9ddd479500f5d36349144a2c29d5`; `linux-base`, `macos-seatbelt`, and aggregate `check` passed; read-only `git diff --check origin/main...HEAD`, `git diff --check`, `git -C zero diff --quiet`, and `git -C zero rev-parse HEAD` passed with zero at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Misleading evidence claims: covered - PR verification claims align with package script `package.json:15`, CI workflow `bun run check` at `.github/workflows/ci.yml:39`, and CI log showing `bun run test:tool-registry-governance`.

Findings:
- None.

Non-blocking notes:
- I did not rerun `bun` or `openspec` locally under the read-only review boundary; CI logs and orchestrator-supplied evidence cover those commands.
