# Proposal

## Why

Issue #344 identified that timestamp subtraction can turn unobserved post-exit delay into a numeric resource measurement. PI comments 6397950076 and 6405181313 authorize a narrower truthful contract: numbers are recomputable original-instance observation windows, not solver-runtime bounds or fixed-precision measurements; missing observation evidence yields null for newly generated records.

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; scope crosses original submission, terminal settlement, collection commit/recovery and canonical schema documentation.
Critical paths: #4 job persistence/recovery and #7 schema/generated projections.
Selected risk packs: Public entry; Concurrency/state; Error handling; File IO/overwrite; Schema/units; Legacy compatibility; Resource limits; Documentation.
Evidence floor: actual consumer RED/GREEN, original online versus recovered execution, terminal-before-record crash/reload, committed immutable re-collection across processes, negative-interval preservation, generated wording from canonical source, native runtime and full default/profile/restart gates.

## What Changes

- Permit a numeric wall_seconds only with matching evidence that the original submitting registry observed the run's terminal transition; both automatic and direct collection use one computation.
- Keep finished_at as settlement observation and keep the existing timestamp-difference formula for trusted windows. Missing, mismatched or lost observation evidence yields null when generating a record, including restarted/adopted execution; no new persistent discriminator.
- Preserve rejection of negative known time intervals, even when observation evidence is missing. Preserve valid committed RunRecord bytes/mtime and do not retroactively certify historical numeric values.
- Align current specifications, schema descriptions/generated projections and operator docs: observation window may contain identity-clock bias, detection delay and online cancellation grace; no solver-runtime upper bound or fixed precision is promised.

## Capabilities

### Modified Capabilities

- `shud-run-jobs`: require original-instance execution observations for newly generated numeric duration, while preserving immutable collection and recovery contracts.

## Impact

Original submission/completion evidence, settlement-to-collector handoff, canonical collector and behavioral tests; RunRecord/RunJob semantic documentation and generated projection support as needed; M2 normative design/specs and current instructions/docs. No schema shape, physical-model/default, process identity, R1–R12 classification, signal, notification, configuration, dependency, host or raw-data changes. Existing valid records remain immutable. #293/#318 and m2-run-chain stay pending centralized PI acceptance; archive only this independent change after engineering delivery.
