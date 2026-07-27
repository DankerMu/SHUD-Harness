# Issue #132 Round 2 semantic red proof

The final proof script requires a committed green SHA, verifies that five governing production/test/spec/script blobs exist at that commit, and refuses any related working-tree, index, or untracked drift. It creates a detached temporary worktree directly from the supplied tree, initializes only the pinned `zero` workspace submodule, and performs a frozen Bun install there；it never copies source, tests, or dependencies from the caller's dirty worktree.

RED applies six semantic regressions to the temporary production source: one publication sweep, realpath-before-no-follow, unmarked exit-code remap, bare PATH-selected Git, delayed handle ownership, and skipped filter preflight. The fixed 17-test selection excludes the three identity-drift rows that the unchanged final pathname recheck already catches. RED must report exactly `0 pass / 17 fail`, name all 17 expected semantic failures, exit 1, and contain no timeout/import/unhandled/harness errors. GREEN restores the production blob from the supplied commit and must report exactly `17 pass / 0 fail` with exit 0. Both phases run twice and must reproduce identical counts.

Executed against committed green tree `f493e77235acbe26ff3f8587192a9eab32efa77e`:

```sh
openspec/changes/m2-research-context/evidence/issue-132-round-2-red-proof.sh --green-sha f493e77235acbe26ff3f8587192a9eab32efa77e
```

Bound blobs:

- collector: `9be4d2f1fec74a34cc82752cdba690adc6a0fb83`
- collector tests: `134c13ba58294ddc48f1f692d0795e707a875364`
- dirty-state tests: `b53d5c46d1ac479ac68197f5aff6adbd8cc17da4`
- governing StackLock spec: `691ad9bf09ea41d3e90794bf1199d21bf66f6607`
- proof script: `25bfbdfbd633eb635225567f6f9bd40aaa162480`

Observed result:

```text
RED[1] 0 pass / 17 named semantic fail / exit 1
GREEN[1] 17 pass / 0 fail / exit 0
RED[2] 0 pass / 17 named semantic fail / exit 1
GREEN[2] 17 pass / 0 fail / exit 0
CLEANUP worktree removed by trap; source tree and index were never modified
```

The first orchestrated replay correctly rejected an incomplete proof environment because the detached worktree lacked the pinned `zero` workspace submodule. The next replay exposed that the PATH regression test used a non-Git root fixture and therefore could pass before reaching a checkout command. The final proof initializes only `zero`, uses a real Git-backed four-checkout fixture for the PATH rows, and binds every expected RED test name; the two clean repetitions above are the accepted evidence.
