## ADDED Requirements

### Requirement: Rendered agent instruction budget is enforced by default

The default instruction and documentation checks SHALL reject rendered AGENTS.md whose physical line count exceeds thresholds.agents_md_max_lines read from constraints.yaml, and SHALL accept a matching projection at the limit. The repository limit SHALL remain 320. A final nonempty unterminated line SHALL count as one line. Invalid or missing budget configuration SHALL fail rather than silently use a default. Both AGENTS.md and CLAUDE.md SHALL retain source-render byte-drift checking; no line budget SHALL be imposed on CLAUDE.md. Source consolidation SHALL preserve effective operating rules, mandatory references and PI authority, without hand-editing generated outputs or changing Runtime Lifecycle content.

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
- **THEN** every enforcement rule and role authority remains in mandatory referenced canonical documentation or the root source, Runtime Lifecycle content is unchanged, and rendered AGENTS.md is at most 320 lines
