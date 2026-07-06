Reviewer agent: `review-correctness`
Review round: follow-up round 2 after Phase 6 fix
Reviewed head SHA: `8e028e5ea1c93e3852aebc2e2714d32834583099`
Summary: final-cand-01 is closed in the executable map/spec/test oracle; one P2 evidence-drift candidate remains in an older workplan fixture note.

Prior finding closure:
- final-cand-01 raw Zero `memory`: closed - current `ROLE_TOOL_IDS` uses `harness.memory.propose` and excludes `memory`; every role list uses `harness.memory.propose` instead of raw `memory`; tests assert `ROLE_TOOL_IDS` excludes `memory`, reviewer raw `memory` is denied, and `repo_explorer` cannot use `harness.memory.propose`. Zero still registers raw `MemoryTool` as `memory`, so closure depends on allowlist exclusion, which is now present.

Invariant Matrix Coverage:
- Exact five roles only: covered.
- Exact sorted `toolIds` snapshot matches OpenSpec oracle: covered.
- `permissionNotes` are excluded from comparable snapshots and subset checks: covered.
- Raw Zero `memory` is excluded from `ROLE_TOOL_IDS` and every role `toolIds` array: covered.
- `harness.memory.propose` is an explicit future proposal-only adapter id and is not raw Zero `memory`: covered.
- `repo_explorer` and `reviewer` contain no write-class ids: covered.
- Only `coordinator` contains `spawn_agent` and `wait_agent`: covered.
- `coordinator` contains no `bash`, `write`, `edit`, `patch.apply`, or raw `memory`: covered.
- `worker` contains no repository source edit ids: covered.
- `coder` alone owns worktree edit/patch ids: covered.
- Helper subset semantics cannot treat permission notes as ids and cannot allow raw Zero `memory`: covered.

Findings:
- Severity: P2
  Failure class: documentation/evidence drift
  Violated contract/invariant: Phase 6 closure should make current workplan/spec evidence consistently state that raw Zero `memory` is not an M1 comparable `toolId`.
  Evidence: `.workplans/issue-24/review/fixture-review-followup-ready.md:9` still says the spec and issue pin `memory(draft)` to exact id `memory`; line 10 still lists `memory` among Zero native names used for this fixture.
  Concrete scenario: A future reviewer or implementer uses this changed workplan fixture as the ready-state summary for task 5.1 or downstream spawn subset work, then reintroduces raw `memory` into `allowed_tools` because this artifact says the fixture was READY with exact id `memory`.
  Consequence: The executable map is currently correct, but the workplan evidence set contains a stale current-state assertion that can mislead later implementation or review and regress the capability boundary final-cand-01 just closed.
  Fix direction: Update or clearly mark this fixture as historical/pre-Phase-6, and ensure its current-state note says `harness.memory.propose` is the proposal-only placeholder while raw Zero `memory` is excluded.
  Required verification: `rg` over `.workplans/issue-24` should no longer find an unqualified current-state claim that `memory(draft)` is pinned to exact id `memory`; remaining raw-memory mentions should be explicitly historical findings or negative tests.
  Sibling surfaces: `.workplans/issue-24/issue-body-with-toolids.md`, `.workplans/issue-24/pr-create-body.md`, Phase 7/verify evidence files, future spawn subset enforcement.
  Blocking status: Non-blocking P2 candidate; the TypeScript/spec/test closure is sound, but the stale evidence should be cleaned up or explicitly deferred.

Non-blocking notes:
- Read-only boundary honored. PR checks were successful, diff check produced no output, and zero HEAD was `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
