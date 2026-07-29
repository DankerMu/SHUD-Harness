# Round 1 — Correctness

Reviewer agent: `issue164_r1_correctness`
Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

Summary: bounded JSON ingress, canonicalization, SHA-peer equality, exact synthetic oracle, and linked-worktree index handling are internally consistent; focused tests are 24/24. One blocking exact-set candidate remains.

## Invariant Matrix Coverage

- Producers: covered by independent three-entry frame construction, committed 152-byte frame/digest, and source/identity fixtures.
- Validators/preflight: strict UTF-8/JSON, duplicates/trailing/depth/node/item, schema, canonicalization, frame, manifest/index reviewed.
- Storage/cache/query: none by contract.
- Public routes/entrypoints: both direct kinds and `--check-current` reviewed and executed.
- Frontend/downstream: #165/#166/#161/#162 boundaries preserved; no production consumer.
- Failure/rollback/stale: covered cases fail closed; stale-source admission candidate below.
- Evidence/readiness: all 26 files reviewed; 24 tests / 279 assertions; current command passed.

## Findings

### P1 — Current-source authority misses untracked OpenSpec and workflow candidates

- Failure class: `contract`
- Invariant: manifest must equal the complete candidate set; any untracked candidate must fail before success.
- Evidence: `current-source.ts:36-43` recognizes all three lanes, but `:137-153` inventories only `spikes/**`; test coverage likewise uses only an untracked spike file.
- Scenario: create untracked `openspec/.../specs/future/spec.md` or `.github/workflows/git-status-capability-spike.yml`; index and spike inventory omit it and the checker succeeds.
- Consequence: normative input is absent from frozen authority while receiving success.
- Fix: enumerate all governed lanes through the same predicate and reject untracked/symlink/non-regular candidates.
- Required proof: public-seam workflow and OpenSpec untracked plus symlink/non-regular cases.
- Siblings: `isCandidate`, filesystem inventory, current checker, authority tests.
- Blocks merge: yes.

## Notes

Aggregate worktree/staged budgets are assigned downstream; network security excluded.
