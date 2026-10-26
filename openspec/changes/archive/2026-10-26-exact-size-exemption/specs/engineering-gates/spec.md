## ADDED Requirements

### Requirement: PR size exemption requires an exact label member

The PR-size gate SHALL receive label names without delimiter ambiguity and SHALL bypass an over-limit diff only when the label-name array contains the exact case-sensitive string size-exempt. Its bypass audit message and step summary SHALL be emitted only for that condition. Existing thresholds, exclusions, label-change triggers, permissions and aggregate-check behavior SHALL remain unchanged.

#### Scenario: Commas do not create an exemption

- **WHEN** an oversized PR has only x,size-exempt or size-exempt,urgent as a single label name, or another near-match/uppercase name
- **THEN** the gate exits1 and emits no exemption audit message or exemption summary
- **AND** an exact size-exempt member in the same array still grants the existing logged bypass

#### Scenario: No usable label array cannot bypass

- **WHEN** an oversized invocation has absent/empty labels, malformed JSON or a JSON value that is not an array
- **THEN** no exemption is granted and the established non-exempt failure path is used
- **AND** a JSON string containing size-exempt is not interpreted as array membership

#### Scenario: Existing size policy is preserved

- **WHEN** the measured diff is at or below the unchanged threshold
- **THEN** it passes without requiring exemption
- **AND** an over-limit diff with an exact member passes with the existing bypass message, while an over-limit diff without that member fails
