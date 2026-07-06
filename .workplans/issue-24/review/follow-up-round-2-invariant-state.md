Reviewer agent: `review-invariant-state`
Review round: follow-up round 2 after Phase 6 fix
Reviewed head SHA: `8e028e5ea1c93e3852aebc2e2714d32834583099`
Summary: Phase 6 closes the raw Zero `memory` authorization path in code/spec/tests; one P2 evidence-drift candidate remains in tracked workplan artifacts.

Prior finding closure:
- final-cand-01 raw Zero `memory`: closed - current map excludes exact `memory` from `ROLE_TOOL_IDS` and role arrays; tests assert `ROLE_TOOL_IDS` does not contain `memory`, `isRoleToolIdSubset("reviewer", ["memory"])` is false, and reviewer cannot allow `memory`. Zero raw `MemoryTool` remains raw and verified-capable, but it is no longer authorized by the M1 comparable role map.

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
  Failure class: stale evidence / identity-drift documentation
  Violated contract/invariant: Phase 6 evidence should preserve the raw Zero `memory` exclusion and avoid collapsing `harness.memory.propose` back to exact Zero `memory`.
  Evidence: `.workplans/issue-24/review/fixture-review-followup-ready.md:9` still says the fixture pins `memory(draft)` to exact id `memory`; `.workplans/issue-24/review/fixture-review-followup-ready.md:10` lists `memory` as a matched Zero native name; `.workplans/issue-24/review/round-1-test-evidence.md:10` still describes the issue task as "`memory` exact id".
  Concrete scenario: A later implementer or verifier reads the tracked workplan evidence instead of the current spec/code and treats exact `memory` as the approved draft-memory id, then reintroduces `memory` into a spawn `allowed_tools` subset or registry lint fixture.
  Consequence: The code-level P1 closure can regress through stale governance evidence, recreating the same identity collapse between raw Zero `memory` and proposal-only memory semantics.
  Fix direction: Mark those old workplan artifacts as superseded by Phase 6 or update their current-evidence claims to `harness.memory.propose`, explicitly stating that raw Zero `memory` is excluded from M1 comparable `toolIds`.
  Required verification: `rg` over `.workplans/issue-24` should leave only clearly historical old-head findings for raw `memory`, while current fixture/closure evidence uses `harness.memory.propose` and says `isRoleToolIdSubset(..., ["memory"])` is false.
  Sibling surfaces: `.workplans/issue-24/review/phase-7-final-review.md`, `.workplans/issue-24/review/verify-final-cand-01.md`, PR body Agent Review section, future task 5.2 registry lint fixtures, future task 3.4 spawn subset enforcement.
  Blocking status: Blocking candidate for claiming the tracked evidence package is internally closed; not a runtime/code invariant blocker because current spec, implementation, tests, and CI close the authorization path.

Non-blocking notes:
- Read-only checks confirmed current PR head, GitHub CI success, clean diff check, clean zero diff, and zero HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
