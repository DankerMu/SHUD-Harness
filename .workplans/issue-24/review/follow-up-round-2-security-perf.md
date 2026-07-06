Reviewer agent: `review-security-perf`
Review round: follow-up round 2 after Phase 6 fix
Reviewed head SHA: `8e028e5ea1c93e3852aebc2e2714d32834583099`
Summary: Phase 6 closes the raw Zero `memory` role-map gap; one P2 evidence-integrity sibling artifact still carries the obsolete raw-`memory` fixture statement.

Prior finding closure:
- final-cand-01 raw Zero `memory`: closed - current `ROLE_TOOL_IDS` contains `harness.memory.propose` and excludes `memory`; tests assert `ROLE_TOOL_IDS` excludes `memory`, reviewer `["memory"]` is denied, and reviewer raw `memory` is not allowed.

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
  Failure class: evidence/data-integrity drift
  Violated contract/invariant: Phase 6 requires raw Zero `memory` to be excluded from M1 comparable `toolIds`, and analogous sibling surfaces should not keep an unsuperseded oracle that pins `memory(draft)` to exact raw `memory`.
  Evidence: `.workplans/issue-24/review/fixture-review-followup-ready.md:9` still says the spec and issue pin `memory(draft)` to exact id `memory`; `.workplans/issue-24/review/fixture-review-followup-ready.md:10` lists raw `memory` among checked Zero native names. Current authoritative sources contradict this at the OpenSpec spec, issue-body workplan, and `role-tool-map.test.ts`.
  Concrete scenario: A later reviewer or spawn-profile implementer reuses the fixture-ready artifact as the READY fixture summary and reconstructs the expected exact tool id as raw `memory`, reintroducing the same allowed-tools regression Phase 6 fixed.
  Consequence: The runtime map is currently safe, but the evidence packet contains a stale capability-boundary oracle that can mislead downstream implementation/review and reopen raw Zero memory mutation authority.
  Fix direction: Update or mark the fixture artifact as superseded by Phase 6, replacing the raw `memory` statement with `harness.memory.propose` and an explicit raw Zero `memory` excluded note.
  Required verification: grep over `.workplans/issue-24`, OpenSpec, and `packages/core/src/tools` should show no non-superseded statement pinning `memory(draft)` to exact raw `memory`; existing role-map tests should still deny `["memory"]`.
  Sibling surfaces: `.workplans/issue-24/review/*`, current follow-up briefs, future task 3.4 spawn subset enforcement, task 5.2 registry lint, M4 memory adapter governance.
  Blocking status: P2 candidate; not a runtime-map blocker, but should be fixed or explicitly deferred before treating `.workplans` review artifacts as current downstream evidence.

Non-blocking notes:
- Prior-head Phase 7 and verifier artifacts correctly preserve the old confirmed finding and were not counted as current failures.
