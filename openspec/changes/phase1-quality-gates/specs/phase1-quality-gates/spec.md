## ADDED Requirements

### Requirement: Phase 1 Verification Command Set

The repository SHALL provide a documented command set that verifies Phase 1 schema, API, workspace, UI, and documentation smoke checks.

#### Scenario: Developer runs Phase 1 verification

- **WHEN** a developer runs the Phase 1 verification command set after dependencies are installed
- **THEN** the command set SHALL execute typecheck, unit tests, integration tests, UI smoke tests, docs link smoke, and requirements ID uniqueness checks

### Requirement: Liveness Health Check

The backend SHALL provide `/api/health/live` for process liveness.

#### Scenario: Live endpoint is called

- **WHEN** a client calls `/api/health/live`
- **THEN** the backend SHALL return a successful response if the process is running

### Requirement: Readiness Health Check

The backend SHALL provide `/api/health/ready` for Phase 1 readiness dependencies.

#### Scenario: Ready endpoint is called after workspace init

- **WHEN** a client calls `/api/health/ready` after workspace initialization
- **THEN** the backend SHALL verify workspace and persistence prerequisites and return a successful response without exposing sensitive absolute paths

### Requirement: Documentation Smoke Checks

The repository SHALL include smoke checks for activated Phase 1 documentation links and requirement ID uniqueness.

#### Scenario: Documentation smoke check runs

- **WHEN** documentation smoke checks are executed
- **THEN** broken activated local links and duplicate requirement IDs SHALL cause the check to fail

### Requirement: Phase 1 Exit Evidence

Phase 1 SHALL have a recorded verification summary before Phase 2 starts.

#### Scenario: Phase 1 exits

- **WHEN** the team declares Phase 1 complete
- **THEN** the verification summary SHALL list the commands run, pass/fail results, and any accepted limitations
