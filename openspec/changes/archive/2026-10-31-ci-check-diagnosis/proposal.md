# Proposal

## Why

Issue #479 records required-check PASS while ordinary merge remains BLOCKED after same-head CI cancellation. PR477 and PR496 show the symptom; PR506 is a CLEAN counterexample. Existing REST run metadata omits webhook action, and run order differs from check-suite order, so a concurrency fix would be speculative.

## Triage

Issue type: bugfix (diagnostic/operational boundary, not assumed scheduler defect)
Fixture level: expanded
Upstream suggested level: absent; expanded for CI shared state and ambiguous hosted behavior.
Blast radius: required-check integrity, merge availability and evidence/secret handling.
Selected risk packs: Config; CLI; Auth/secrets; Concurrency; Error handling; Documentation.
Evidence floor: isolated same-head hosted overlap with actual actions, all job/suite/check identities and before/after merge state; unchanged fail-closed self-proof; full local gate; exact-head CI/review and ordinary merge.

## What Changes

- Emit only allowlisted public event/action/run-attempt/head/ref metadata in the existing aggregate's log, without modifying its verdict or job graph.
- Diagnose an isolated PR's opened/labeled overlap; distinguish natural concurrency cancellation from any explicit controlled cancellation. Preserve PR477 baseline and contradictory results.
- Document evidence-backed inspection and all-job rerun recovery on an unchanged head in existing Testing_Strategy. Report reproducible service-side discrepancy upstream; do not claim undocumented internal selection logic.

## Capabilities

### Modified Capabilities

- `engineering-gates`: add auditable CI event diagnosis and non-bypass same-head recovery contract; existing seven-job/label/failure requirements remain unchanged.

## Impact

Only `.github/workflows/ci.yml`, existing engineering documentation and this fixture. No new dependency, runtime change, policy change, retry automation, empty commit, size-exemption change, protection/ruleset change or M3 PI acceptance.
