## ADDED Requirements

### Requirement: Workspace Initialization API

The backend SHALL provide `POST /api/workspace/init` to initialize the configured workspace.

#### Scenario: Workspace init succeeds

- **WHEN** a client calls `POST /api/workspace/init`
- **THEN** the backend SHALL initialize the workspace and return a successful response without exposing sensitive absolute paths

### Requirement: Task Creation API

The backend SHALL provide `POST /api/tasks` to create a TaskCard using shared schema validation and workspace persistence.

#### Scenario: Valid task is created

- **WHEN** a client submits a valid task creation request
- **THEN** the backend SHALL create a TaskCard, persist its snapshot, and return the created TaskCard

#### Scenario: Invalid task request is rejected

- **WHEN** a client submits an invalid task creation request
- **THEN** the backend SHALL return a non-2xx API error envelope and SHALL NOT persist a TaskCard

### Requirement: Task Read APIs

The backend SHALL provide `GET /api/tasks` and `GET /api/tasks/:id` for listing and reading persisted TaskCards.

#### Scenario: Existing task is read

- **WHEN** a client requests an existing TaskCard ID
- **THEN** the backend SHALL return the persisted TaskCard

#### Scenario: Missing task returns not found

- **WHEN** a client requests a TaskCard ID that does not exist
- **THEN** the backend SHALL return a not found API error envelope

### Requirement: API Error Envelope

All non-2xx API responses SHALL use the canonical API error envelope.

#### Scenario: Schema error occurs

- **WHEN** request validation fails
- **THEN** the response SHALL include `error_id`, `category`, `severity`, `message`, `user_message`, `evidence_refs`, `retryable`, and `recommended_next_actions`

### Requirement: Task Create Idempotency Skeleton

Task creation SHALL support an `Idempotency-Key` header skeleton that prevents accidental duplicate object creation for repeated matching requests.

#### Scenario: Matching idempotent request is repeated

- **WHEN** the same task creation request is repeated with the same `Idempotency-Key`
- **THEN** the backend SHALL return the original created TaskCard instead of creating a duplicate
