# Issue #132 Phase 6.2 invariant-closure semantic proof

This committed-SHA/blob-bound replay covers the three independently verified Phase 6.2 findings: effective stat-refresh config parity, stably absent stage-0 nested dirty state, and collection-wide protected temporary authority. It mutates production only inside a detached proof worktree and runs each of the three unique full-test-title selectors in its own canonical Bun 1.2.19 process.

For each of two repetitions, every RED row must exit 1 with exactly its named semantic failure and a one-test `0 pass / 1 fail` summary. After restoring the committed collector, every GREEN row must exit 0 with exactly its named pass and a one-test `1 pass / 0 fail` summary. Harness/import/timeout/runtime failures are forbidden, and the trap removes the detached worktree without touching the source tree or index.

Final execution is intentionally deferred until the orchestrator commits the completed green tree:

```sh
openspec/changes/m2-research-context/evidence/issue-132-phase-6.2-red-proof.sh --green-sha <committed-green-sha>
```

No future SHA、blob identity or final execution count is asserted in this pre-commit record.
