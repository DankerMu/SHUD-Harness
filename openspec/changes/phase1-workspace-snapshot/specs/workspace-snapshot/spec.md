## ADDED Requirements

### Requirement: Workspace Initialization

The system SHALL initialize the Phase 1 workspace directory tree under a configured workspace root.

#### Scenario: New workspace is initialized

- **WHEN** workspace initialization is requested for an empty workspace root
- **THEN** the system SHALL create the Phase 1 directories required for tasks, artifacts, snapshots, locks, sessions, and temporary files

### Requirement: Workspace Path Safety

The system SHALL reject workspace operations that resolve outside the configured workspace root.

#### Scenario: Escaping path is rejected

- **WHEN** a workspace operation receives a path containing traversal that resolves outside the workspace root
- **THEN** the operation SHALL fail without creating or modifying files outside the workspace

### Requirement: Task Snapshot Persistence

The system SHALL persist TaskCard snapshots using schema validation and atomic writes.

#### Scenario: Task snapshot is written and reloaded

- **WHEN** a valid TaskCard snapshot is written and the service is reloaded
- **THEN** the same TaskCard SHALL be readable from the workspace state

#### Scenario: Invalid Task snapshot is rejected

- **WHEN** a snapshot payload fails TaskCard schema validation
- **THEN** the system SHALL reject the write and SHALL NOT replace the previous valid snapshot

### Requirement: Monotonic Local ID Allocation

The system SHALL allocate Phase 1 object IDs monotonically within the workspace.

#### Scenario: Two task IDs are allocated

- **WHEN** two TaskCard IDs are allocated in sequence
- **THEN** the second ID SHALL be greater than the first according to the configured ID format
