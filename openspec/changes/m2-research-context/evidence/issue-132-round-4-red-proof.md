# Issue #132 Round 4 semantic red proof

This replay binds the committed green SHA and the six governing blobs for the Round 4 observation-snapshot redesign. It selects nine independent public-seam regressions spanning index timestamp/data integrity, safe ignore and text-conversion parity, split-index completeness/drift, canonical Git booleans, external temporary placement, and deinitialized nested compatibility.

The script applies semantic production mutants only in a detached proof worktree, then runs each of nine escaped、unique full-test-title selectors in its own canonical Bun 1.2.19 process. Every RED row must exit 1 with exactly its named semantic failure and a `0 pass / 1 fail` one-test summary；after restoring the committed collector, every GREEN row must exit 0 with exactly its named pass and a `1 pass / 0 fail` one-test summary. Explicit diagnostics reject count drift、selector fan-out、harness/import/timeout/runtime failures. Both repetitions run with global and system Git configuration disabled so nested checkout setup cannot borrow ambient author identity.

Final execution is intentionally deferred until the orchestrator creates the green commit. The proof MUST be invoked as:

```sh
openspec/changes/m2-research-context/evidence/issue-132-round-4-red-proof.sh --green-sha <committed-green-sha>
```

No future SHA, blob identity, or execution count is asserted in this pre-commit record.
