## MODIFIED Requirements

### Requirement: Native settlement tests observe completion prerequisites

Native tests that consume settlement results or collect a completed run SHALL wait for the required observable completion state with a bounded deadline while driving accepted registry work. A single joined tick SHALL NOT be treated as proof of settlement. Isolation tests SHALL continue to assert protected entries remain unchanged on every waiting iteration. Production dispatch semantics and all existing outcome, identity and evidence assertions SHALL remain unchanged. Post-readiness tests of pending notifications without session services SHALL await the documented waiting presentation before comparing the collected snapshot, rather than pinning submission-time detail. A held-persistence lifecycle oracle SHALL establish the intended post-exit work admission before comparing completion against barrier entry, and SHALL independently verify the publication metadata boundary while preserving single-flight, independent-run progress and exact terminal-write assertions. Diagnostic attribution SHALL distinguish an observed controlled schedule from an untraced historical failure.

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

#### Scenario: Held metadata gates constrain a freshly admitted lifecycle step

- **WHEN** real exit evidence and the first metadata latch are ready before timer work is admitted and manual ticks overlap that work
- **THEN** the held run remains running with no completion or terminal-write attempt while another run can settle
- **AND** releasing the initial metadata latch reaches a separately held publication metadata gate with the same no-terminal-progress assertions
- **AND** releasing the publication gate completes the run exactly once with one terminal-write attempt and one successful write
- **AND** a genuine gate bypass or caught polling failure yields a bounded failure with gate phase and pre-cleanup durable evidence, not a retry, skip or relaxed timeout
