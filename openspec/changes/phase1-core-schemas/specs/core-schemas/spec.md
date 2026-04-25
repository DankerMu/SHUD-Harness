## ADDED Requirements

### Requirement: TaskCard Schema

The core package SHALL provide a Zod schema and inferred TypeScript type for Phase 1 TaskCard objects using the canonical status, type, runtime phase, owner, budget, and linkage fields.

#### Scenario: Valid TaskCard is accepted

- **WHEN** a TaskCard payload includes required canonical fields and allowed enum values
- **THEN** the TaskCard schema SHALL parse it successfully and return a typed value

#### Scenario: Invalid TaskCard status is rejected

- **WHEN** a TaskCard payload uses a status outside the canonical status enum
- **THEN** the TaskCard schema SHALL reject the payload with a schema error

### Requirement: Support Schema Subset

The core package SHALL provide Zod schemas and inferred TypeScript types for Artifact, ErrorRecord, IdempotencyRecord, and LockRecord.

#### Scenario: Invalid support enum is rejected

- **WHEN** an Artifact, ErrorRecord, IdempotencyRecord, or LockRecord payload uses an unsupported enum value
- **THEN** the corresponding schema SHALL reject the payload

### Requirement: Shared Schema Exports

The core package SHALL export schemas and inferred types from stable module entrypoints for backend and frontend packages.

#### Scenario: Backend imports schema

- **WHEN** backend code imports a Phase 1 schema from the core package
- **THEN** the import SHALL resolve without referencing schema implementation files by relative path

### Requirement: Schema Unit Coverage

The repository SHALL include unit tests for successful parsing and expected validation failures for all Phase 1 schemas.

#### Scenario: Schema tests run

- **WHEN** the schema test suite is executed
- **THEN** it SHALL cover at least one valid and one invalid payload for each Phase 1 schema
