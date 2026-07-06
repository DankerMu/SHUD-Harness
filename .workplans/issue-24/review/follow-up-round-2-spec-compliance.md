Reviewer agent: `review-spec-compliance`
Review round: follow-up round 2 after Phase 6 fix
Reviewed head SHA: `8e028e5ea1c93e3852aebc2e2714d32834583099`
Summary: Phase 6 closes the code/spec/test raw `memory` gap, but the GitHub issue and one fixture evidence file still preserve the superseded raw `memory` oracle.

Prior finding closure:
- final-cand-01 raw Zero `memory`: closed - current `ROLE_TOOL_IDS` excludes `memory` and uses `harness.memory.propose`; tests assert `ROLE_TOOL_IDS` excludes `memory`, reviewer raw `memory` is denied, and `harness.memory.propose` remains explicit.

Invariant Matrix Coverage:
- OpenSpec/issue/task compliance: missing - OpenSpec and local workplan align with `harness.memory.propose`, but GitHub issue #24 body still lists raw `memory`; see finding.
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
- Scope creep / registry lint / guard_class / spawn policy / frozen docs edits: covered.
- Acceptance criteria coverage: covered for implemented code/tests.

Findings:
- Severity: P1
  Failure class: contract/evidence drift
  Violated contract/invariant: Issue #24 / fixture evidence for task 5.1 must match the canonical OpenSpec oracle and Phase 6 raw-memory exclusion; the PR also claims the issue body was clarified.
  Evidence: `gh issue view 24 --json body` still shows raw `memory` as a Zero native id and exact role oracle; `.workplans/issue-24/review/fixture-review-followup-ready.md:9` still says `memory(draft)` is pinned to exact id `memory`; PR body claims "Clarify the OpenSpec fixture and GitHub issue body".
  Concrete scenario: A verifier or downstream implementer checks the GitHub issue after this PR closes #24 and sees reviewer/coordinator/worker should use exact `memory`, while the merged code/spec correctly reject raw `memory`. That makes the issue acceptance oracle contradict the fix.
  Consequence: The Phase 6 closure is not auditable from the external issue source, and future spawn-policy or registry work can accidentally reintroduce raw Zero `memory` by following the stale issue/fixture evidence.
  Fix direction: Update GitHub issue #24 body, or add an authoritative superseding issue comment, so its exact snapshot uses `harness.memory.propose` and explicitly excludes raw Zero `memory`; also supersede or amend the fixture follow-up note that says `memory(draft)` maps to exact `memory`.
  Required verification: Re-run `gh issue view 24 --json body --jq .body` and confirm no current acceptance/oracle section authorizes raw `memory`; confirm `.workplans/issue-24` contains no active fixture readiness statement pinning `memory(draft)` to exact `memory`.
  Sibling surfaces: PR body, `.workplans/issue-24/issue-body-with-toolids.md`, fixture review docs, future task 3.4 spawn subset enforcement, task 5.2 registry lint, M4 memory adapter work.
  Blocking status: Blocking candidate for evidence/contract closure before merge.

Non-blocking notes:
- GitHub PR status for this head showed `linux-base`, `macos-seatbelt`, and `check` all successful.
