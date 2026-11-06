## MODIFIED Requirements

### Requirement: Rendered agent instruction budget is enforced by default

The default instruction and documentation checks SHALL reject rendered AGENTS.md whose physical line count exceeds thresholds.agents_md_max_lines read from constraints.yaml, and SHALL accept a matching projection at the limit. The repository limit SHALL remain 320. A final nonempty unterminated line SHALL count as one line. Invalid or missing budget configuration SHALL fail rather than silently use a default. Both AGENTS.md and CLAUDE.md SHALL retain source-render byte-drift checking; no line budget SHALL be imposed on CLAUDE.md. Source consolidation SHALL preserve effective operating rules, mandatory references and PI authority, without hand-editing generated outputs. Runtime Lifecycle content MAY move from the root source to a canonical implementation document only losslessly: retained root lines plus the relocated document SHALL equal the original section in original relative order, modulo link-path rebasing; the root source SHALL keep a mandatory-read reference to that document; and the document SHALL be listed in doc_gate.path_claim_files.

#### Scenario: Exact and exceeded rendered limits
- **WHEN** matching projections contain AGENTS.md with exactly 320 lines or 321 lines under the canonical limit
- **THEN** the default instruction check passes the 320-line case and fails the 321-line case
- **AND** the documentation gate and its CI job execute the same enforcement

#### Scenario: Constraint source and CLAUDE scope
- **WHEN** an isolated fixture changes the configured limit, or only its byte-matching CLAUDE.md exceeds 320 lines
- **THEN** AGENTS acceptance follows the configured limit and excess CLAUDE lines alone do not fail the check
- **AND** a hand-edited projection or invalid budget still fails

#### Scenario: Rule-preserving source consolidation
- **WHEN** the shared canonical source is shortened and both root projections are regenerated
- **THEN** every enforcement rule and role authority remains in mandatory referenced canonical documentation or the root source, and rendered AGENTS.md is at most 320 lines

#### Scenario: Lossless Runtime Lifecycle relocation
- **WHEN** Runtime Lifecycle paragraphs move from the shared source to a canonical implementation document
- **THEN** retained root lines plus the relocated document reproduce every original non-blank line exactly once in original relative order, differing only in rebased link paths
- **AND** the root keeps a mandatory-read reference, and the documentation path-claim gate scans the relocated document

## ADDED Requirements

### Requirement: Rendered agent instruction byte budget is enforced by default

The default instruction and documentation checks SHALL reject rendered AGENTS.md whose raw byte length exceeds thresholds.agents_md_max_bytes read from constraints.yaml, and SHALL accept a matching projection exactly at the limit. Missing, duplicate or non-positive-decimal byte budget configuration SHALL fail rather than silently use a default, independently of the line budget. No byte budget SHALL be imposed on CLAUDE.md. The rejection diagnostic SHALL name AGENTS.md, the measured byte count, the configured limit and the configuration key.

#### Scenario: Exact and exceeded byte limits
- **WHEN** matching projections contain AGENTS.md of exactly the configured byte limit, or one byte more
- **THEN** the default instruction check accepts the exact case and rejects the larger case with a byte-budget diagnostic
- **AND** an isolated fixture with a different configured limit follows that limit

#### Scenario: Byte budget scope and configuration
- **WHEN** only a byte-matching CLAUDE.md exceeds the byte limit, or the byte budget is missing, duplicated or malformed while the line budget is valid
- **THEN** CLAUDE-only excess is accepted, and every invalid byte configuration fails as invalid budget configuration without a fallback
