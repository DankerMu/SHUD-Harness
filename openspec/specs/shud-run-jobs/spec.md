# shud-run-jobs Specification

## Purpose
Define configuration, integrity and evidence boundaries for the SHUD job lifecycle, preserving safe output reads, exclusive state ownership and fail-loud runtime construction.

## Requirements

### Requirement: SHUD stdout regular-file read boundary

For both locally submitted and recovered SHUD registrations, each stdout read SHALL reject a final-component symbolic link and any nonregular opened file. A FIFO SHALL NOT block the host while opening the source. Read failure SHALL preserve the existing parent warning-and-stop behavior and SHALL NOT append target bytes to the job output. Opened descriptors SHALL be released on successful and failed reads. Ordinary-file incremental UTF-8, short-read, spill-path, truncation and missing-file semantics SHALL remain unchanged. This boundary does not prove original inode identity for hardlinks or prevent concurrent ancestor replacement under the existing single-user threat model.

#### Scenario: Symbolic link replaces stdout

- **WHEN** stdout.log is replaced by a symbolic link to a harmless external sentinel file before the next output read
- **THEN** the source throws without returning target text, the parent reports the source failure, and public job output retains existing chunks without sentinel bytes

#### Scenario: Nonregular stdout replacement

- **WHEN** stdout.log is replaced by a FIFO without a writer or by a directory
- **THEN** the read fails without waiting for a FIFO writer, and any opened descriptor is released

#### Scenario: Normal incremental output remains compatible

- **WHEN** a regular stdout log grows across UTF-8 boundaries, produces short reads, is truncated, or disappears
- **THEN** complete bytes advance the cursor, incomplete characters remain unconsumed, short reads consume only initialized bytes, truncation is lossy, spill paths remain intact, and disappearance throws rather than returning fabricated empty output

### Requirement: Lock release failures preserve ownership evidence

A state-directory release SHALL attempt owned metadata removal once while holding kernel exclusion, then attempt descriptor closure regardless of removal failure. A release failure SHALL identify stateDir, metadata path, operation and error code, preserve original failures, and distinguish successful guard release from uncertain closure. Initialization failure and cleanup failure SHALL remain observable together. A matching live-self residue SHALL still reject acquisition with a diagnostic distinct from a busy/foreign holder. No automatic retry or live-owner takeover SHALL occur. Index bytes and the permanent coordination inode SHALL remain unchanged by release failure and recovery.

#### Scenario: Metadata removal fails but descriptor closes

- **WHEN** owned lock metadata cannot be removed due to a filesystem error and descriptor closure succeeds
- **THEN** the single lifecycle failure report identifies the failed removal and released kernel guard while retaining the original error
- **AND** repeated close returns the same rejection without another removal or report, and live-self metadata still blocks new registry acquisition

#### Scenario: Descriptor closure also fails

- **WHEN** descriptor closure fails, with or without metadata removal failure
- **THEN** the report states guard release is uncertain and retains every failure rather than masking one or claiming successful release

#### Scenario: Initialization and cleanup both fail

- **WHEN** index initialization fails and ownership cleanup also fails
- **THEN** both original errors remain reachable, prior index bytes are preserved, and the diagnostic does not replace the initialization cause with only a release error

#### Scenario: Operator restores availability safely

- **WHEN** filesystem health is restored and ownership is proven inactive, with metadata verification/removal protected by the permanent kernel guard or normal stale acquisition after host exit
- **THEN** a new registry can acquire the stateDir with unchanged valid indexes and guard inode
- **AND** no procedure removes the guard inode, alters index content or permits a second writer

### Requirement: Registry construction requires resolved cadence

The registry SHALL consume the cadence resolved through its Cordis configuration schema without a separate default lookup. Plugin input SHALL retain optional parent configuration keys and existing defaults. Construction with a missing or non-positive-safe-integer cadence SHALL fail before acquiring state ownership or publishing a jobs service, with a diagnostic requiring parsed configuration. This guard SHALL NOT establish direct construction as a supported configuration path. Submission, execution and polling SHALL continue sharing the same resolved cadence.

#### Scenario: Unresolved direct construction is rejected

- **WHEN** a direct caller omits the cadence or supplies zero or a fractional value
- **THEN** construction fails at the explicit parsed-configuration precondition without publishing jobs or acquiring state ownership, rather than silently synthesizing one parent default

#### Scenario: Plugin configuration remains authoritative

- **WHEN** Cordis constructs the registry using default or explicit valid parent configuration
- **THEN** the parent schema's resolved cadence is consumed unchanged by submission, execution and polling, with no new keys, defaults or required plugin-input fields

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

### Requirement: SHUD exit code regular-file read boundary

The shared exit evidence reader used by settlement, recovery, cancellation and collection SHALL reject a final-component symbolic link and any nonregular opened file before reading its content. Opening a FIFO without a writer SHALL NOT wait for a writer. Validation and content reading SHALL refer to the same opened descriptor, and every acquired descriptor SHALL enter guaranteed cleanup on successful and failed reads. Unsafe or unreadable evidence SHALL use the existing unreadable result, not absence, an invented integer or an escaping exception; genuine missing evidence and strict integer parsing SHALL retain their existing semantics. A descriptor-close failure SHALL report unreadable rather than authorize numeric success or claim proven closure. This boundary does not authenticate hardlinks, original inode identity or concurrently replaced ancestors under the existing single-user model.

#### Scenario: Linked numeric target cannot authorize settlement

- **WHEN** exit_code is replaced by a symbolic link to an external regular file containing a valid integer, or a dangling symbolic link
- **THEN** the shared reader returns unreadable without adopting target bytes
- **AND** settlement publishes failed with null exit_code and an explicit unreadable diagnostic, not a numeric-exit or lost detail, while target/source evidence remains unchanged

#### Scenario: Nonregular exit evidence is bounded

- **WHEN** exit_code is a FIFO without a writer or a directory
- **THEN** the reader returns unreadable within a bounded operation without waiting for a FIFO writer
- **AND** any acquired descriptor is released through cleanup, with a close failure reported as unreadable rather than fabricated success

#### Scenario: Existing evidence classification is preserved

- **WHEN** exit_code is a missing path, a regular file containing a valid safe integer, invalid integer text, or encounters EACCES/EIO
- **THEN** the reader respectively returns absent, that integer, invalid, or unreadable using the existing result model
- **AND** reading does not mutate the source; read/stat failures still attempt descriptor closure, and a close failure cannot authorize success or escape the result model

#### Scenario: Collection retains its controlled rejection vocabulary

- **WHEN** collection observes a static symlink or nonregular exit path through its existing precheck
- **THEN** its existing SYMLINK/NOT_REGULAR diagnostic and collect-error retry behavior remain unchanged
- **AND** all settlement/recovery callers and collection use the same descriptor-safe reader without copied caller-specific guards or dependence on precheck-to-read path stability
