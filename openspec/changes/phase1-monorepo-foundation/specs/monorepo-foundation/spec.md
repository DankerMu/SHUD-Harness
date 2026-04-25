## ADDED Requirements

### Requirement: Root Workspace Definition

The repository SHALL define a root Bun/TypeScript workspace for Harness implementation code while keeping the four source submodules outside the workspace package graph.

#### Scenario: Workspace packages are discoverable

- **WHEN** a developer inspects the root package metadata
- **THEN** the workspace SHALL include Harness implementation packages and SHALL NOT include `SHUD`, `rSHUD`, `AutoSHUD`, or `zero` as workspace packages

### Requirement: Standard Developer Commands

The repository SHALL expose standard root commands for typecheck, test, build, and documentation checks.

#### Scenario: Commands are listed at the root

- **WHEN** a developer runs the package manager command list or reads `package.json`
- **THEN** the root SHALL expose commands for `typecheck`, `test`, `build`, and docs validation entrypoints

### Requirement: Shared TypeScript Configuration

The repository SHALL provide shared TypeScript configuration used by all Harness packages.

#### Scenario: Package configuration extends shared config

- **WHEN** a Harness package defines a TypeScript project
- **THEN** it SHALL extend or reference the shared root TypeScript configuration instead of maintaining unrelated compiler settings

### Requirement: Submodules Remain Read-Only References

The foundation SHALL preserve SHUD, rSHUD, AutoSHUD, and Zero as source references and SHALL NOT require implementation edits inside those submodules.

#### Scenario: Foundation change is applied

- **WHEN** the monorepo foundation is added
- **THEN** no files inside `SHUD/`, `rSHUD/`, `AutoSHUD/`, or `zero/` SHALL be modified by this change
