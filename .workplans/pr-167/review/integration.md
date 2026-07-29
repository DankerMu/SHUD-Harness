# Round 1 — Integration

Reviewer agent: `issue164_r1_integration`
Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

Summary: two P1 contract candidates; 24/24 tests and all public commands/full check passed.

## Invariant Matrix Coverage

- Producers: synthetic oracle covered; source-record, identity projection, and current source are three separate channels.
- Validators: ingress/schema/oracle/peer equality covered; current set omits non-spike untracked candidates.
- Storage/cache/query: none.
- Public entrypoints: exact receipts covered; possible cross-entry identity ambiguity.
- Downstream: future slices must consume frozen authority without redefining it.
- Failure/stale: covered malformed/limit/oracle cases fail closed; two candidates may false-succeed.
- Evidence: focused/full checks pass; negative cases below absent.

## Findings

### P1 — Three success entrypoints do not jointly prove one source authority

- Failure class: `contract`
- Invariant: source record, identity projection, source vector and peers must identify one authority before downstream consumption.
- Scenario: source record uses SHA A, identity projection uses B for all peers, current files are C; all three commands independently succeed and receipts contain only `input_kind`.
- Evidence: `checker.ts:8-59`, `schemas.ts:68-92`, design invariant matrix.
- Consequence: future children can combine sibling success receipts from different source generations.
- Fix: joint validation boundary or identity-bearing receipts that enforce one source identity.
- Required proof: A/B/C mismatch fails; identical authority produces a correlatable success receipt.
- Siblings: #165/#166/#161/#162.
- Blocks merge: yes.

### P1 — Untracked workflow/OpenSpec candidates are not rejected

- Failure class: `contract`
- Invariant/scenario/evidence/fix/proof: same complete-candidate-set defect as the correctness report; inventory currently traverses only `spikes/**`.
- Siblings: downstream manifest regeneration and Task 5.1 workflow freeze.
- Blocks merge: yes.

## Notes

Removed behavior clean; checker forwarding faithful; later-child boundaries preserved; network security excluded.
