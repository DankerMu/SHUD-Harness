## ADDED Requirements

### Requirement: Local agent evidence is separate from formatted deliverables

The repository SHALL define the entire root `.workplans/` as untracked local agent evidence, with issue-, PR- and change-name ownership conventions and one repository-distributed ignore source inherited by both Git and the existing formatter. Consumed evidence SHALL NOT be rewritten to make a deliverable gate pass. Source/deliverable formatting checks, CI commands and unrelated local configuration SHALL remain unchanged. The policy and its PI-authorized rationale SHALL be available through the existing project-local workflow contract and mirrored engineering instructions.

#### Scenario: Evidence namespaces use one portable policy

- **WHEN** valid unformatted JSON exists under `.workplans/issue-<number>/`, `.workplans/pr-<number>/` or `.workplans/<change-name>/`
- **THEN** Git and the normal formatter exclude all three from delivery discovery using the same distributed rule, without formatting those files
- **AND** the obsolete local-only PR-evidence exclusion is no longer needed or retained as its policy source

#### Scenario: Noncompliant deliverable still fails

- **WHEN** equivalent unformatted JSON is checked in a nonignored source location
- **THEN** formatting exits nonzero for that source, while a correctly formatted control passes
- **AND** the repository formatting command and CI behavior are not weakened

#### Scenario: Existing consumed evidence is preserved

- **WHEN** the policy is applied in a checkout containing existing evidence and other local exclude rules
- **THEN** existing evidence bytes and unrelated local rules remain unchanged, and no evidence file is added to tracking
- **AND** root review-gate state remains handled by its existing separate policy rather than being accidentally exposed by removing its exclusion

#### Scenario: Workflow writers find the project-owned contract

- **WHEN** issue workflows consume the active project profile through their documented seam, or design-workflow writers follow canonical repository instructions directing them to that profile
- **THEN** they find one reference to the local evidence ownership/naming policy and the prohibition on rewriting consumed oracle evidence
- **AND** runtime skill projections and external repositories are not edited to carry a project-only rule
