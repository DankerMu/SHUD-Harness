## ADDED Requirements

### Requirement: SHUD source provenance participates in documentation path checks

SHUD_IO_Facts SHALL identify its pinned review baseline and express every Source path in the existing path checker's recognized citation form. Under initialized pinned submodules, the normal documentation path command SHALL reject a nonexistent cited SHUD path and accept the corrected document. CI documentation verification SHALL obtain the actual pinned submodule sources before checking those paths. Existence verification SHALL NOT be described as scientific validation; source pin, solver behavior, exit-code values and existing public documentation anchors SHALL remain unchanged.

#### Scenario: Invalid source citation is rejected

- **WHEN** an enrolled SHUD_IO_Facts copy cites nonexistent SHUD/src/IO/read_func.cpp as an independently backticked path and the pinned SHUD root is initialized
- **THEN** the normal documentation path command exits nonzero and identifies the offending citation
- **AND** replacing that citation with the verified existing source restores successful checking without changing checker rules

#### Scenario: CI checks real pinned source content

- **WHEN** the documentation gate runs in a clean CI checkout
- **THEN** pinned submodule source content is obtained before path checking and the corrected document participates in that check
- **AND** the delivered evidence records the actual checkout and check result, not merely a configuration claim

#### Scenario: Source facts match the referenced pin

- **WHEN** readers follow the document's time, table-header, initial-condition, positional-column, warning and state-vector citations
- **THEN** paths and cited ranges resolve, the documented names and arithmetic match the pinned source, and changed provenance does not alter solver inputs or outputs
- **AND** an issue's stale counts or header names do not override the current pinned source

#### Scenario: Verification scope is explicit

- **WHEN** the document and PR report verification
- **THEN** they distinguish path existence from reviewed source facts and from unperformed scientific validation
- **AND** the unchanged checker limitation for absent submodule roots, local initialization prerequisite, unchanged exit-code anchor/values and deferred optional sibling R repair are explicit
