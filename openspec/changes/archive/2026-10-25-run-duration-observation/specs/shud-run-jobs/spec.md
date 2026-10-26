## ADDED Requirements

### Requirement: Numeric run duration requires original-instance observation evidence

For a newly generated RunRecord, numeric resources.wall_seconds SHALL require matching evidence of the original submitting registry's accepted execution start and its own successful terminal observation. The value SHALL equal the nonnegative difference between the observed run's finished_at and started_at in seconds. finished_at SHALL remain the settlement-observation timestamp, not solver exit time. The value SHALL be described as an observation window, potentially including start-clock bias, detection delay and local cancellation grace, not solver runtime, a solver-runtime upper bound or a fixed-precision measurement. Missing or mismatched observation evidence SHALL produce null without inventing zero. Process identity/timestamp semantics, existing exit classification, signal authority, notification and persistent record shapes SHALL remain unchanged.

#### Scenario: Original online execution is observed

- **WHEN** the original submitting registry observes valid numeric exit evidence, or its controlled cancellation reaches the existing quiescence condition, and publishes that run's terminal transition
- **THEN** automatic and direct generation produce the same recomputable observation window from the matching start and settlement timestamps
- **AND** later completion or collection retries do not advance the observed endpoint

#### Scenario: Restarted or adopted execution lacks original observations

- **WHEN** a new registry or process settles or collects an uncommitted run, including a still-running adopted execution or recovered cancellation
- **THEN** the newly generated record has null wall_seconds even when both durable timestamps or a replacement registration exist
- **AND** the original identity, timestamps, outcome, signals and notification behavior remain otherwise unchanged

#### Scenario: No trustworthy terminal observation exists

- **WHEN** execution is lost, exit evidence is invalid/unreadable, or a terminal record was installed without this instance observing its transition
- **THEN** that state cannot authorize a numeric duration, and existing settlement/collection error behavior remains authoritative

#### Scenario: Observation evidence no longer matches

- **WHEN** an otherwise valid record has a different run/process identity or different start/finish instants from the original observations
- **THEN** generation withholds the duration as null instead of treating the old observation as evidence for the replacement

#### Scenario: Negative known interval remains invalid

- **WHEN** an uncommitted record has known finished_at earlier than started_at, whether or not original observation evidence exists
- **THEN** collection retains its controlled validation failure and error ledger behavior, and publishes no RunRecord
- **AND** the invalid interval is not clamped or hidden by substituting null

#### Scenario: Unknown endpoint remains unknown

- **WHEN** either required timestamp is null
- **THEN** a newly generated record has null duration rather than a fabricated zero

#### Scenario: Process dies after terminal publication but before result commit

- **WHEN** the original host publishes the terminal RunJob and then dies before committing RunRecord
- **THEN** collection in another process preserves the existing settlement timestamp and generates null duration because the observation evidence was lost

#### Scenario: Same-instance generation retry retains its observation

- **WHEN** terminal observation succeeded but completion or result generation fails before RunRecord commit, including exhausted automatic retries
- **THEN** a later eligible same-instance retry retains the same observation window without rewriting finished_at or treating adoption as original execution

#### Scenario: Committed result is immutable across recovery

- **WHEN** a valid same-identity RunRecord already exists, including after failed collected projection or in another process
- **THEN** the existing value, bytes and modification time are preserved before any new duration-generation logic
- **AND** historical numeric values are not rewritten or retroactively certified

#### Scenario: Canonical time semantics reach generated projections

- **WHEN** the canonical existing time-field descriptions are generated into JSON Schema and Markdown
- **THEN** both projections carry the same observation/null/settlement semantics, including descriptions on nullable fields
- **AND** validation constraints, enum values, existing generated paths and unannotated fields remain unchanged
