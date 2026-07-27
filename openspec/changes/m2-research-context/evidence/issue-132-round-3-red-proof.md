# Issue #132 Round 3 semantic red proof

Round 3 supersedes the Round 2 proof for the dirty-observer, effective-config, and nested-index-parser security claims. The historical Round 2 proof at committed tree `f493e77235acbe26ff3f8587192a9eab32efa77e` remains valid evidence for its then-selected publication/path/handle/filter-preflight claims, but its preflight-only filter mutant does not prove the post-audit injection boundary repaired in Round 3.

The Round 3 script accepts only an explicit committed green SHA, verifies five governing production/test/spec/script blobs at that SHA, and rejects related working-tree, index, or untracked drift. It creates a detached temporary worktree, initializes only pinned `zero`, installs with the frozen lockfile, applies source-bound semantic mutants, restores the committed collector blob immediately, and removes all proof resources through a trap. It never invents a future SHA or records an unexecuted result.

The fixed selection contains 15 security tests: audit→external filter injection; main/linked/nested worktree-scope clean/process including include expansion; LF/U+2028/U+2029 stage-0 gitlink recursion; stage 1/2/3 gitlink conflict; unknown-stage and malformed-header fail-closed parsing. RED disables worktree-scope audit, replaces the isolated observer with repository-configured parent status, and weakens NUL/stage/path parsing. Every named test must fail semantically with exactly `0 pass / 15 fail`; timeout/import/unhandled/panic/harness failures are rejected. GREEN must report exactly `15 pass / 0 fail`. Both phases repeat twice. The clean nested fsmonitor case remains an explicit regression row but is not counted as a new-behavior red oracle because it already passed the pre-Round3 implementation.

Final execution completed against committed green tree `92b5422bb2ff1ff0f6646d67257c0b9a21476582`:

```sh
sh openspec/changes/m2-research-context/evidence/issue-132-round-3-red-proof.sh \
  --green-sha 92b5422bb2ff1ff0f6646d67257c0b9a21476582
```

The proof bound these five committed blobs:

- `8459055a59b9e0fc59cd5105651c1b57456c1533` — `stack-lock-collector.ts`
- `59b796c0939633ef807a9fa74ee5630b1ae70e71` — `stack-lock-collector.test.ts`
- `3b6e26d565722c767658152091d6eeb8030763ca` — `stack-lock-dirty-state.test.ts`
- `74c5a50973a80e3c54d98916337bc5e3e5a660c7` — `specs/stack-lock/spec.md`
- `5d9850a58343f2a4a6977f910409d0e6596b09a8` — this proof script

Both repetitions produced RED `0 pass / 15 named semantic fail / exit 1`, restored the committed collector, then produced GREEN `15 pass / 0 fail / exit 0`. The exit trap removed the detached worktree；the source tree and index were never modified.

An earlier pre-publication replay correctly refused a `1 pass / 14 fail` RED result. That refusal exposed that the audit→injection test still depended on a later audit rather than the dirty observer's authority boundary. The test was tightened to remove the injected config after the first status observation and to assert that status uses a non-repository `--git-dir`; only then was the successful result above recorded.
