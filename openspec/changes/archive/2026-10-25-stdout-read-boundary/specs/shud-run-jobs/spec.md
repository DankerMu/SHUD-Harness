## Purpose

Define the integrity boundary for model-visible SHUD job output so regular-file logs retain incremental behavior while unsafe log replacements fail visibly without blocking the host.

## ADDED Requirements

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
