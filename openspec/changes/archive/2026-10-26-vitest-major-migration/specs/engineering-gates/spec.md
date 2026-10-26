## ADDED Requirements

### Requirement: Frozen test-toolchain installs provide required peers

With automatic peer installation disabled, the committed dependency graph SHALL explicitly provide the test runner's required runtime peers and a matching coverage provider on the project's pinned Node runtime. A toolchain migration SHALL preserve test discovery and the existing four coverage thresholds and exclusions; dependency-update policy and version documentation SHALL reflect only completed migrations.

#### Scenario: Frozen installation runs tests and coverage

- **WHEN** dependencies are installed from the committed frozen lockfile without automatic peer installation
- **THEN** the default check executes the discovered tests and matching coverage provider without a missing-peer import failure
- **AND** each of lines, statements, functions and branches meets the unchanged 80 percent floor

#### Scenario: Unsupported adjacent migration stays deferred

- **WHEN** the test runner is upgraded but the TypeScript major is unsupported by the lint toolchain
- **THEN** TypeScript and its major-update ignore remain unchanged, as do Node runtime and Node type majors
- **AND** only completed runner/provider migrations leave the major-ignore list
