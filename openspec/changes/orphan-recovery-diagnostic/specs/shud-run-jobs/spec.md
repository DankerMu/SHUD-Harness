## ADDED Requirements

### Requirement: Unowned R7 settlement discloses unproven group quiescence

After R7 terminal settlement without retained recovered group control, the runtime SHALL warn through an operator-visible stderr log route that the recorded wrapper identity is no longer live/matching and historical group quiescence is unverified. The warning SHALL identify the run and recorded process identity and state that no signal is sent to an unowned historical group. Existing cancelled/lost classification SHALL NOT imply all descendants stopped. This distinction is log-only and SHALL NOT add persistent fields/files or change notifications, signal authority or reconciliation actions. The new route SHALL forward only this plugin instance's dedicated recovery diagnostics, not unrelated logs or arbitrary errors.

#### Scenario: Unowned recorded wrapper disappears or is replaced

- **WHEN** final R7 classification has no exit evidence and no retained recovered control, with or without cancellation intent
- **THEN** successful terminal settlement emits a contextual warning, while existing outcome classification and no-signal behavior remain unchanged
- **AND** it does not claim an orphan definitely exists, nor repeat the warning merely because collection or later terminal recovery occurs

#### Scenario: Exit evidence wins on reread

- **WHEN** the existing reread changes R7 classification to R6
- **THEN** normal exit settlement proceeds without the unowned-group warning

#### Scenario: Earlier R8 control survives leader loss

- **WHEN** this instance retains previously proven recovered group control across an error and leader loss
- **THEN** existing group-quiescence and owned-signal rules remain authoritative, and terminal settlement does not emit a false unowned-group warning

#### Scenario: Diagnostic sink isolation and disposal

- **WHEN** unrelated loggers or other facades emit messages, including a same-name facade, or the owning plugin is disposed
- **THEN** the instance's diagnostic sink does not forward those messages
- **AND** a replacement plugin emits its own eligible R7 diagnostic exactly once to stderr

#### Scenario: Operator diagnostic output is unavailable

- **WHEN** stderr has a closed pipe reader or closed descriptor when an eligible diagnostic is emitted
- **THEN** that diagnostic may be lost, but its write failure SHALL NOT terminate the host or interrupt settlement and collection
- **AND** failure handling SHALL own only that write, without a shared-stream error listener, retry or fallback output channel

#### Scenario: Durable record is read after the diagnostic window

- **WHEN** logs were lost or a crash occurred between terminal publication and warning
- **THEN** the unchanged RunRecord cannot permanently distinguish this residual, and documentation explicitly states that limitation rather than promising durable quiescence evidence
