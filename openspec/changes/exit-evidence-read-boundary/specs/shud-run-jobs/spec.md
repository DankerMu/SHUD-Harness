## ADDED Requirements

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
