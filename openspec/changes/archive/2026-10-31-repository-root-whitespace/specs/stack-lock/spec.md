## ADDED Requirements

### Requirement: Repository root pathname fidelity

Repository revision collection SHALL preserve legal whitespace in the configured physical root pathname. The reported git top-level pathname SHALL be obtained by removing only the single final LF record terminator, if present, rather than trimming pathname content. The existing physical-root equality check and refusal to collect an enclosing repository SHALL remain in force. Collection SHALL retain the existing four read-only git operations, environment isolation and revision fields.

#### Scenario: Committed root with trailing whitespace
- **WHEN** a committed repository root basename ends in a space or LF
- **THEN** collection succeeds with that repository's full commit, branch, dirty flag and dirty paths, preserving pathname content independently of git's output terminator

#### Scenario: Descendant of whitespace-ended root
- **WHEN** collection is requested for an empty descendant inside that repository rather than its root
- **THEN** it throws the existing non-root error and does not return the enclosing repository's revision
