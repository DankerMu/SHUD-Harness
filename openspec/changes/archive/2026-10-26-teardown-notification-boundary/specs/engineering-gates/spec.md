## MODIFIED Requirements

### Requirement: Native settlement tests observe completion prerequisites

Native tests that consume settlement results or collect a completed run SHALL wait for the required observable completion state with a bounded deadline while driving accepted registry work. A single joined tick SHALL NOT be treated as proof of settlement. Isolation tests SHALL continue to assert protected entries remain unchanged on every waiting iteration. Production dispatch semantics and all existing outcome, identity and evidence assertions SHALL remain unchanged. Post-readiness tests of pending notifications without session services SHALL await the documented waiting presentation before comparing the collected snapshot, rather than pinning submission-time detail.

#### Scenario: Joined work returns before settlement

- **WHEN** an accepted step returns before observing newly published exit evidence
- **THEN** the test continues driving and waiting for completion before reading settlement results or collecting
- **AND** every iteration retains bad-entry immutability and non-completion assertions where applicable
- **AND** permanent non-completion produces a bounded, site-identifying timeout rather than bypassing assertions or retrying collection

#### Scenario: Normal cadence publishes waiting notification after recovery

- **WHEN** recovery has become ready without session services and normal cadence publishes the pending notification's waiting presentation
- **THEN** the cross-platform teardown test waits for that presentation with a bounded deadline before comparing the collected record
- **AND** collected status, original cancellation timestamp, null exit code and pending notification status, zero attempts and null notification time remain exact assertions
- **AND** pre-readiness immutability, signal sequences, original grace deadline, completion events, cancelled result, empty registration/session delivery and platform-specific recovery warning assertions remain unchanged
