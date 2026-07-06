Reviewer agent: `review-test-evidence`
Review round: follow-up round 2 after Phase 6 fix
Reviewed head SHA: `8e028e5ea1c93e3852aebc2e2714d32834583099`
Summary: final-cand-01 is closed in code/spec/tests; one P2 evidence-hygiene finding remains for stale/misleading issue-review evidence.

Prior finding closure:
- final-cand-01 raw Zero `memory`: closed - current spec excludes raw `memory` and defines `harness.memory.propose` as a future proposal-only adapter; implementation uses `harness.memory.propose` and omits `memory` from `ROLE_TOOL_IDS`; tests assert `ROLE_TOOL_IDS` excludes `memory`, reviewer raw `memory` is not allowed, and repo_explorer cannot use `harness.memory.propose`. CI `linux-base` ran `role-tool-map.test.ts` with `11 pass, 0 fail`.

Invariant Matrix Coverage:
- Issue task: mapping table constant in `packages/core`: covered.
- Issue task: exact sorted `toolIds` snapshot: covered.
- Issue task: 4+ invariant tests: covered.
- Issue AC: exactly five canonical roles: covered.
- Issue AC: invariant tests pass: covered.
- Issue AC: map drift without snapshot update fails: covered.
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
- Local/CI evidence freshness: covered.
- Misleading evidence claims: partially covered - current code/spec/tests are aligned, but stale PR/fixture evidence remains; see finding.

Findings:
- Severity: P2
  Failure class: misleading evidence claim
  Violated contract/invariant: Follow-up review evidence should not leave unsuperseded claims that raw Zero `memory` is the exact accepted id after Phase 6 changed the contract to `harness.memory.propose`.
  Evidence: `.workplans/issue-24/review/fixture-review-followup-ready.md:9` still says the spec and issue pin `memory(draft)` to exact id `memory`; `.workplans/issue-24/pr-create-body.md:8` says the GitHub issue body was clarified, but `gh issue view 24 --json body` during this review still returned the old raw-`memory` oracle.
  Concrete scenario: A downstream reviewer maps Issue #24 or the fixture-ready artifact to the current PR and concludes raw `memory` is still the intended comparable `toolIds` id, despite current code/spec/tests rejecting it.
  Consequence: The evidence trail can reintroduce the same ambiguity that final-cand-01 fixed, especially if issue/workplan artifacts are used as the acceptance source for the next spawn subset enforcement task.
  Fix direction: Mark the stale fixture-ready note as superseded by Phase 6 or update it to `harness.memory.propose`; either update the live GitHub issue body or revise the PR claim to say only the local issue-body artifact was clarified.
  Required verification: `gh issue view 24 --json body` no longer shows raw `memory` in the exact oracle, or the PR body no longer claims the live issue was clarified; fixture-ready should have no unsuperseded stale claim.
  Sibling surfaces: `.workplans/issue-24/review/*`, live GitHub Issue #24 body, PR body, future task 3.4 spawn subset enforcement review inputs.
  Blocking status: Non-blocking for runtime behavior; should be corrected or explicitly marked superseded before relying on `.workplans` as the authoritative evidence bundle.

Non-blocking notes:
- Read-only review used CI logs and git/gh evidence instead of local reruns.
