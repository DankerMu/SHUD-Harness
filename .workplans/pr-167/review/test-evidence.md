# Round 1 — Test & Evidence

Reviewer agent: `issue164_r1_test_evidence`
Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

Summary: focused tests, public success commands, full local check, strict OpenSpec and hygiene pass. Two blocking evidence candidates remain.

## Findings

### P1 — Declared structural source limits are not realizable at the public seam

- Failure class: `test-evidence` (review label: spec/implementation mismatch)
- Invariant: every exact byte/depth/node/item source-record ceiling is publicly evidenced.
- Scenario: admitted schema has shallow fixed depth; node count requires more items than allowed, so public exact/node+1 cannot occur. Tests use arbitrary arrays and relaxed sibling ceilings.
- Evidence: spec profiles/scenarios and `source-ingress.test.ts:108-134` direct parser tests.
- Consequence: three of four resource acceptance rows are unproven and node code unreachable.
- Fix: make each advertised bound reachable by an otherwise valid admitted input or formally revise through the oracle-authority process; no test-only peer-limit substitution.
- Required proof: real `SOURCE_PROFILE` public exact/+1 cases with precise receipts plus mutation sensitivity.
- Siblings: metadata/profile/constants/parser/schema/OpenSpec.
- Blocks merge: yes.

### P1 — Oracle mutation classes bypass public current-check

- Failure class: `test-evidence`
- Invariant: entry count/order/path/mode/content/framing/digest/trailing/truncation mutations must fail through public current-check.
- Scenario: current checker stops invoking/mishandles oracle validation; internal helper unit tests remain green. Only truncation and one same-length mutation reach `--check-current`.
- Evidence: `synthetic-oracle.test.ts:69-89` calls helper directly; `current-source-authority.test.ts:196-209` covers only two public mutations.
- Consequence: public false-success regression can evade the suite.
- Fix: reproduce every frozen oracle mutation in a temporary tracked repo and run the public current-check.
- Required proof: every named mutation exits 2, empty stdout, one exact error, unchanged status/inventory, zero helper launch.
- Siblings: current checker, checker facade, frame/sidecar fixtures.
- Blocks merge: yes.

## Matrix / notes

Producer independence, no-write/static seam, future-owner separation, surrogate and 14 SHA subset forgeries covered. Validators/public/failure/evidence are partial for the two findings. Local checks pass. Remote macOS CI is red in raw-data sandbox and must be handled before merge; Linux/docs were green at review time. Network security excluded.
