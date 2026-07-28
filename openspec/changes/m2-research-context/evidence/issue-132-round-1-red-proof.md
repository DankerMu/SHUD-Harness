# Issue #132 Round 1 source-bound red proof

> Historical record only. The original replay implementation was retired after Round 2 found that it copied caller worktree files and accepted arbitrary non-zero RED outcomes. Its path now delegates to the committed-tree/blob-bound Round 2 proof, which requires `--green-sha`, checks exact semantic failure counts, repeats RED/GREEN twice, and rejects related dirty paths. The counts below describe the historical run and are not presented as replayable by the retired implementation.

- Base production SHA: `c9ea4fb325f2b4c9ff5c4693ffb90aa13ae8445e`.
- Production source set: `packages/core/src/domain/schemas/stack-lock.ts` and `packages/core/src/domain/services/stack-lock-collector.ts`.
- Final tests retained: `core-schemas.test.ts`, `stack-lock-collector.test.ts`, and `stack-lock-dirty-state.test.ts`.
- Exact command: `npx --yes bun@1.2.19 test packages/core/src/domain/schemas/core-schemas.test.ts packages/core/src/domain/services/stack-lock-collector.test.ts packages/core/src/domain/services/stack-lock-dirty-state.test.ts`.
- Reproducer: `openspec/changes/m2-research-context/evidence/issue-132-round-1-red-proof.sh` creates an isolated temporary worktree, overlays the final source/tests, replaces only the production source set with the fixed base versions for RED, restores the final sources for GREEN, and removes the worktree via `trap`.

## Recorded result

- RED (fixed base production sources, final tests): exit `1`; `89 pass / 69 fail`, `441 expect()` calls, 158 tests across 3 files.
- GREEN (final production sources restored, identical command): exit `0`; `158 pass / 0 fail`, `577 expect()` calls, 158 tests across 3 files.
- Cleanup proof: the temporary worktree disappeared from `git worktree list`; `git stash list` contained no `red-proof` entry before or after execution; no stash was created.

The reproducer does not create a Git stash and refuses to run when a `red-proof` stash already exists. Recorded on 2026-07-27 from the final working tree.
