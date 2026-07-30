# PR #170 Round 1 — correctness

Reviewer agent: correctness
Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Summary: Blocking candidates remain despite 19/19 focused tests passing.

## Findings

### P1 resource — cleanup failure overwrites the primary contract error

- Contract: an already-selected stable ingress error remains the public first cause while cleanup settles every descriptor.
- Scenario/evidence: `ingress.ts` selects `CONTRACT_BYTES_LIMIT`, but `closeAll()` throws `CONTRACT_SCHEMA_INVALID` from `finally`; JavaScript replaces the pending exception. Admission cleanup has the same shape.
- Consequence: exact receipts become cleanup-fault dependent and lose the primary cause.
- Fix/proof: collect cleanup failure without overriding an existing primary; fault-inject close failures for both kinds and prove all remaining closes are attempted.
- Siblings: admission cleanup and verification-descriptor cleanup. Blocking: yes.

### P1 test-evidence — syscall/Linux proof is absent from required CI

- Contract: Darwin/Linux stress and an independent post-admission root/absolute-open tripwire.
- Evidence: repository CI does not run the focused suite; the test observes implementation-emitted callbacks rather than actual syscalls.
- Fix/proof: exact-head focused runs on both OSes and an active control that makes an injected forbidden open fail.
- Siblings: #169 consumers. Blocking: yes.

### P2 test-evidence — exact depth boundary is uncovered

- Scenario: changing depth comparison from `>` to `>=` rejects legal depth 12 while the suite, which only checks depth 13, stays green.
- Fix/proof: exact depth 12 reaches semantic validation and depth 13 returns `CONTRACT_JSON_DEPTH_LIMIT`.
- Siblings: other ingress profiles. Blocking under explicit acceptance criteria: yes.

Invariant matrix: producer and validators covered; descriptor path logic covered on Darwin; failure/cleanup lacks close-fault proof; Linux and independent syscall evidence missing; excluded siblings untouched.
