## ADDED Requirements

### Requirement: Pinned R API provenance participates in documentation checks

The canonical rSHUD/AutoSHUD reference SHALL identify its pinned source-review baseline, correct its API claims and question-style review premises against that baseline, and expose every Source path to the existing documentation path checker. Under initialized pinned submodules, the default path command SHALL reject nonexistent cited R source paths and accept the corrected document. This change SHALL NOT modify source pins, R/C++ behavior, checker rules or unrelated source-reference documents.

#### Scenario: Default gate rejects a missing R citation

- **WHEN** an enrolled document copy cites nonexistent rSHUD/R/Interface.R as a separately backticked path and the rSHUD root is initialized
- **THEN** default documentation path checking exits nonzero with the offending citation
- **AND** restoring the corrected document yields success without checker changes

#### Scenario: Readers receive pin-correct API facts

- **WHEN** readers follow citations for output readers, outlet helpers, projection, environment/conversion handling, input validation, test scope, function signatures and pipeline/source-code dispatch
- **THEN** paths and line ranges resolve and each claim distinguishes the actual implementation or caller it describes
- **AND** false checklist premises and stale Verified assertions do not survive merely because their paths now exist

#### Scenario: Verification boundaries remain honest

- **WHEN** the PR and document report verification
- **THEN** source inspection, executed path checks and any actually executed runtime tests are distinguished; scientific validation and unrun R tests are not claimed
- **AND** the local missing-submodule-root skip is disclosed and actual CI pinned-submodule checkout plus path checking are recorded without requiring full history
