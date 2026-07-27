# Issue #132 Round 3 semantic red proof

Round 3 supersedes the Round 2 proof for the dirty-observer, effective-config, and nested-index-parser security claims. The historical Round 2 proof at committed tree `f493e77235acbe26ff3f8587192a9eab32efa77e` remains valid evidence for its then-selected publication/path/handle/filter-preflight claims, but its preflight-only filter mutant does not prove the post-audit injection boundary repaired in Round 3.

The Round 3 script accepts only an explicit committed green SHA, verifies five governing production/test/spec/script blobs at that SHA, and rejects related working-tree, index, or untracked drift. It creates a detached temporary worktree, initializes only pinned `zero`, installs with the frozen lockfile, applies source-bound semantic mutants, restores the committed collector blob immediately, and removes all proof resources through a trap. It never invents a future SHA or records an unexecuted result.

The fixed selection contains 15 security tests: audit→external filter injection; main/linked/nested worktree-scope clean/process including include expansion; LF/U+2028/U+2029 stage-0 gitlink recursion; stage 1/2/3 gitlink conflict; unknown-stage and malformed-header fail-closed parsing. RED disables worktree-scope audit, replaces the isolated observer with repository-configured parent status, and weakens NUL/stage/path parsing. Every named test must fail semantically with exactly `0 pass / 15 fail`; timeout/import/unhandled/panic/harness failures are rejected. GREEN must report exactly `15 pass / 0 fail`. Both phases repeat twice. The clean nested fsmonitor case remains an explicit regression row but is not counted as a new-behavior red oracle because it already passed the pre-Round3 implementation.

Final execution is intentionally deferred to the orchestrator after commit:

```sh
openspec/changes/m2-research-context/evidence/issue-132-round-3-red-proof.sh --green-sha <committed-green-sha>
```

The script prints the exact committed SHA, five blob IDs, command, setup, two RED/GREEN repetitions, and cleanup result. Until that command runs, no Round 3 SHA/blob/count result is claimed.
