# Round 1 — Spec Compliance

Reviewer agent: `issue164_r1_spec`
Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

Summary: three P1 candidates. Parsing, canonicalization, four-peer equality, exact oracle, scope and deterministic receipts are implemented.

## Findings

### P1 — Untracked OpenSpec/workflow candidates ignored

- Failure class: `contract`
- Complete finding: same constructible false-success, evidence, consequence, full-lane inventory fix and public negative proof as correctness/integration.
- Blocks merge: yes.

### P1 — Current-source traversal/reads are unbounded

- Failure class: `resource`
- Complete finding: same large-file/wide-tree scenario, `current-source.ts:137-180` evidence, deterministic-bound consequence, frozen budgets/incremental hashing fix and exact/+1 proof as resource review.
- Blocks merge: yes.

### P1 — Public exact depth/node/item evidence missing and node code unreachable

- Failure class: `test-evidence`
- Invariant: Task 1.1a claims public exact/+1 coverage for every source limit.
- Scenario: CLI/profile regression remains green because tests call parser directly with relaxed peer limits; node code cannot be reached under frozen profiles.
- Evidence: tasks/design claims; only byte case uses `capture`; structural cases bypass public seam.
- Consequence: checked task and evidence overstate contract.
- Fix: make profile executable and truthful, with real public exact/+1 cases, or explicitly narrow the oracle via authorized fixture decision.
- Required proof: requirement-to-test mapping and exact public receipts for every reachable limit.
- Siblings: profiles, metadata, contract JSON, tasks/design/spec.
- Blocks merge: yes.

## Compliance / Matrix

Kinds, future-kind rejection, Bun/no-write/no-process, UTF-8/JSON/surrogate, canonicalization, schema/results, four peers, exact oracle, synchronized oracle attacks, receipts, scope, full check and OpenSpec are done. Exact manifest set, bounded current reads, and public structural bound evidence are missing. Storage is absent; downstream ownership remains correct. Network security excluded.
