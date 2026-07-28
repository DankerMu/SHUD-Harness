# Issue #132 Phase 6.2 invariant-closure semantic proof

This committed-SHA/blob-bound replay covers the three independently verified Phase 6.2 findings: effective stat-refresh config parity, stably absent stage-0 nested dirty state, and collection-wide protected temporary authority. It mutates production only inside a detached proof worktree and runs each of the three unique full-test-title selectors in its own canonical Bun 1.2.19 process.

For each of two repetitions, every RED row must exit 1 with exactly its named semantic failure and a one-test `0 pass / 1 fail` summary. After restoring the committed collector, every GREEN row must exit 0 with exactly its named pass and a one-test `1 pass / 0 fail` summary. Harness/import/timeout/runtime failures are forbidden, and the trap removes the detached worktree without touching the source tree or index.

The accepted replay ran against committed green tree `2bc80023424cf37c299690cba04bd4d0add124fd` and bound these governing blobs:

- collector: `d52ad07137c69422900fb9e344b5434df7020756`
- dirty-state test: `599bb24a252554ed7a74c9f9c640ca3a88fb3d56`
- design: `99bcd4ca34619853d1867c9ce9bab26566294c21`
- StackLock spec: `13fd5742d1828371737771ab4bbbdf85be57dc08`
- primary evidence: `cf91144969ba3db7ee53f5993f58fb913a1b3f1a`
- proof script: `0689a884c55b390e0d3651c7bea19411eaf6f6e0`

Both repetitions produced RED `3/3` exact named semantic failures followed by GREEN `3/3` exact named passes. Every row ran in its own Bun 1.2.19 process；the trap removed the detached worktree and source/index were never modified. The accepted invocation was:

```sh
openspec/changes/m2-research-context/evidence/issue-132-phase-6.2-red-proof.sh --green-sha 2bc80023424cf37c299690cba04bd4d0add124fd
```

No harness、import、timeout or runtime failure was accepted as semantic RED evidence.
