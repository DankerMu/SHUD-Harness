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
