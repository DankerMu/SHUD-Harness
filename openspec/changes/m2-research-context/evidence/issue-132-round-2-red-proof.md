# Issue #132 Round 2 semantic red proof

The final proof script requires a committed green SHA, verifies that five governing production/test/spec/script blobs exist at that commit, and refuses any related working-tree, index, or untracked drift. It creates a detached temporary worktree directly from the supplied tree and performs a frozen Bun install there；it never copies source, tests, or dependencies from the caller's dirty worktree.

RED applies six isolated semantic regressions to the temporary production source: one publication sweep, realpath-before-no-follow, unmarked exit-code remap, bare PATH-selected Git, delayed handle ownership, and skipped filter preflight. The fixed 20-test selection must report exactly `0 pass / 20 fail` with exit 1 and no timeout/import/unhandled/harness errors. GREEN restores the production blob from the supplied commit and must report exactly `20 pass / 0 fail` with exit 0. Both phases run twice and must reproduce identical counts.

Run after the orchestrator creates the final green commit:

```sh
openspec/changes/m2-research-context/evidence/issue-132-round-2-red-proof.sh --green-sha <final-green-sha>
```

The script prints the actual commit, five blob IDs, exact command, both RED/GREEN repetitions, and cleanup result. This document intentionally does not invent the future final SHA, blob IDs, or execution output.
