# Round 4 candidate synthesis

Reviewed head: `64f548385c9cf3bd6cd7fff3bf244641827a4d61`
Base: `f8b74e724dc978acb889f715a936feabfd69680d`
Reviewers: correctness, integration, test/evidence, spec compliance, invariant.

Deduplicated candidates:

- `r4-data-01` P1 data-integrity: generation/final-set recheck covers only the
  three semantic sources; a verified ordinary candidate or earlier config/index/
  manifest/inventory input can drift while later admissions run and success may
  still be issued.
- `r4-contract-01` P2 contract: executable-mode derivation uses any execute bit
  (`0111`) while Git maps regular-file mode from the owner execute bit (`0100`),
  rejecting a Git-clean `0645` file recorded as `100644`.
- `r4-contract-02` P1 contract/evidence-integrity: the frozen scope command
  requires empty output but the final diff includes `.review-gate-issues.json`
  and `.workplans/pr-167/**`; persisted evidence nevertheless claims scope clean.
- `r4-evidence-01` P1 test-evidence: public exact depth/item tests use otherwise
  schema-invalid arrays and expect schema failure, so they do not prove the
  stated otherwise-valid exact-boundary behavior.
- `r4-evidence-02` P1 test-evidence: both mandatory source-only red artifacts omit
  test-tree binding, pinned tool identity and exact overlay/restore commands; a
  replay found a Round 3 assertion-count mismatch.
- `r4-contract-03` P1 contract/evidence-integrity: PR body/manifest/history contain
  conflicting current metrics/state, and an older Phase 6.2 clean conclusion at
  `618bc86` is not marked superseded by the Round 2 v4 finding at the same SHA.

Explicit boundaries remain unchanged: aggregate traversal/read budgets are #162;
Git executable/HEAD/profile authority is #166; network is excluded.
