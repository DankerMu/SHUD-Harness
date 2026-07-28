# Issue #132 Round 4 semantic red proof

This replay binds the committed green SHA and the six governing blobs for the Round 4 observation-snapshot redesign. It selects nine independent public-seam regressions spanning index timestamp/data integrity, safe ignore and text-conversion parity, split-index completeness/drift, canonical Git booleans, external temporary placement, and deinitialized nested compatibility.

The script applies semantic production mutants only in a detached proof worktree, then runs each of nine escaped、unique full-test-title selectors in its own canonical Bun 1.2.19 process. Every RED row must exit 1 with exactly its named semantic failure and a `0 pass / 1 fail` one-test summary；after restoring the committed collector, every GREEN row must exit 0 with exactly its named pass and a `1 pass / 0 fail` one-test summary. Explicit diagnostics reject count drift、selector fan-out、harness/import/timeout/runtime failures. Both repetitions run with global and system Git configuration disabled so nested checkout setup cannot borrow ambient author identity.

The accepted replay ran against committed green tree `6a81d7c51eeaae6d5c09cc3130bb9aa1e2267ce9` and bound these governing blobs:

- collector: `a7a735157d4d7be76223af8948af49ef095996c9`
- dirty-state test: `7f03cb26d1804b4c6529b01c375cc888b193ee1a`
- design: `43709333ff80db88d7b687d03336bc6ead0630e1`
- StackLock spec: `c51fa16cbc77a93cb12cedfa4f3d8eca1de082e0`
- primary evidence: `67ce56c1413e7e48f016e19801ad2786149f8a5e`
- proof script: `d1d66caa1900128408eba555d90fa60dc0110eca`

Both repetitions produced RED `9/9` exact named semantic failures with every row exiting 1, followed by GREEN `9/9` exact named passes with every row exiting 0. The trap removed the detached worktree；the source tree and index were never modified. The accepted invocation was:

```sh
openspec/changes/m2-research-context/evidence/issue-132-round-4-red-proof.sh --green-sha 6a81d7c51eeaae6d5c09cc3130bb9aa1e2267ce9
```

An earlier replay on `6e387eefaafda67fe256d69a3b58f5a8f733d43f` was rejected before any RED result was accepted because one selector expanded to three tests and Bun 1.2.19 proved unstable when several targeted real-Git tests shared one process. The proof harness was corrected to one unique full-title selector per Bun process before this final result was recorded；no runtime or test behavior was weakened.
