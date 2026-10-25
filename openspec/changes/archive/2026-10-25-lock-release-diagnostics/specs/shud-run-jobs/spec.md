## ADDED Requirements

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
