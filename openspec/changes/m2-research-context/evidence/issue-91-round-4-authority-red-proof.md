# Issue #91 Round 4 HEAD-object authority red proof

## Bound source state

- Workflow repair base: `b354f09ed28fd8725f34a45f3cda98798517abde`.
- Pre-repair production blob, `packages/core/src/domain/services/stack-lock-collector.ts`: `6256434fd00706527eebe26b33af34aafb64bf7e`.
- Repaired production blob: `0e63fd03109237069d525abb245fe2c04e8c4321`.
- Regression-test blob, `packages/core/src/domain/services/stack-lock-collector.test.ts`: `33dfd14eb0169cf023e4170915def531439111c2`.
- The test oracle is the active D7a contract: four gitlinks and the `.gitmodules` blob identity come from one bounded `HEAD` inventory, and branches come from a bounded read of that exact object rather than mutable worktree bytes.

## Reviewer scenario red loop

Before the redesign, the real-Git regression was run alone:

```text
npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-collector.test.ts --test-name-pattern 'rejects committed branch authority drift despite a stable canonical worktree'
```

Result against the pre-repair producer: exit `1`; `0 pass`, `1 fail`. The collector returned a complete StackLock carrying the canonical dirty-worktree `zero.branch=development` even though committed `HEAD:.gitmodules` declared `zero.branch=main`. This reproduces the verified mixed-generation contract defect at the public collector boundary.

## Batched source-bound replay

The repaired production source alone was stashed with:

```text
git stash push -m 'red-proof-issue-91-head-authority' -- packages/core/src/domain/services/stack-lock-collector.ts
```

The new tests remained in the worktree, and this exact batch ran against the restored pre-repair source blob:

```text
npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-collector.test.ts --test-name-pattern 'collects four gitlinks|missing HEAD \.gitmodules|wrong-mode HEAD \.gitmodules|malformed HEAD \.gitmodules blob|non-UTF-8 HEAD \.gitmodules blob|exact 64 KiB HEAD \.gitmodules|committed \.gitmodules object generation|derives branches from HEAD|untracked canonical worktree|committed branch authority drift'
```

Red result: exit `1`; `0 pass`, `10 fail`, `51 filtered out`, `9 expect()` calls. The failures cover exact inventory/blob argv, missing and wrong-mode HEAD entries, malformed/non-UTF-8 and bounded HEAD blob reads, object-generation transition, dirty-worktree isolation, untracked-worktree rejection, and committed-branch authority.

The stash was popped immediately. The same exact batch then returned exit `0`; `10 pass`, `0 fail`, `51 filtered out`, `36 expect()` calls.

## Hygiene

- `git stash list | rg 'red-proof-issue-91-head-authority'` returned no match after the immediate pop.
- `git diff --check` passed after restoration.
- No temporary repository, trace sink, remote operation, commit, or push was left by the proof. Test fixtures clean their temporary real-Git repositories in `afterEach`.
