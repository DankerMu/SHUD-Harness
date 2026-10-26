# engineering-gates Specification

## Purpose
Define executable engineering checks whose success accurately describes the delivered code surfaces covered by the repository's default local and continuous-integration gate.

## Requirements

### Requirement: Root production scripts participate in blocking typecheck

The default typecheck command SHALL compile production TypeScript scripts under scripts with the repository's unchanged strict base compiler settings, in addition to existing package checks. Script compilation SHALL emit no build artifacts and SHALL resolve Node types from an explicit root dependency aligned with the existing package version. This addition SHALL NOT include test/fixture entrypoints or expand the package test typechecking surface.

#### Scenario: Script strict-null error blocks the default gate

- **WHEN** a production script contains a strict nullability violation
- **THEN** the default typecheck command exits nonzero and reports that script's file and location
- **AND** after restoring valid source the default command succeeds

#### Scenario: Frozen dependency installation supports script checks

- **WHEN** dependencies are installed using the committed frozen lockfile
- **THEN** script compiler Node types resolve without sibling-package path overrides, existing package checks still run, and no script JavaScript/declaration build artifacts are emitted

#### Scenario: Test fixtures stay outside the new program

- **WHEN** a TypeScript test or fixture exists under the scripts tree
- **THEN** it is not added as an entrypoint of the production script compiler program and the existing package test exclusions remain unchanged

### Requirement: PR size exemptions are reevaluated on label changes

For PRs to main, granting or revoking size-exempt SHALL trigger CI reevaluation without a commit or close/reopen. An over-limit PR SHALL pass the size gate only while exempted and SHALL record the bypass. Label events SHALL run all existing required jobs; the sole all-checks-passed gate SHALL fail whenever any required job is failed, cancelled or skipped. Existing opened/synchronize/reopened and push-main triggers SHALL remain active. The cost of rerunning full CI for unrelated labels SHALL be explicitly documented; the threshold and exemption policy SHALL remain unchanged.

#### Scenario: Grant exemption after opening an oversized PR

- **WHEN** size-exempt is added to an oversized PR after it was opened without that label
- **THEN** a new CI run evaluates the same head, logs the bypass and succeeds in both size and aggregate checks when all other jobs succeed

#### Scenario: Revoke exemption without changing the commit

- **WHEN** size-exempt is removed from that same oversized PR
- **THEN** a new CI run fails the size check and required aggregate without needing another commit or reopening the PR

#### Scenario: Required job cannot be skipped into success

- **WHEN** the aggregate receives any required job result of failure, cancelled or skipped
- **THEN** it exits nonzero; only all-success input passes

#### Scenario: Unrelated label changes preserve full-check semantics

- **WHEN** a different label is added or removed
- **THEN** the full job set runs under the documented cost policy, with no label-based skip of the required aggregate

### Requirement: Native fixture cleanup failures preserve diagnostic evidence

Default test and CI failure output SHALL retain captured cleanup failures' nested messages, stacks, aggregate members and causes, with known execution pid/pgid and a failure-time process-state snapshot. Unknown identity or unavailable snapshot SHALL be explicit and SHALL NOT replace the underlying error. An earlier test-body or observed pending rejection SHALL remain observable alongside cleanup failure. Successful cleanup after a body failure SHALL preserve the original body error. Diagnostic changes SHALL preserve each surface's existing cleanup order and stop-or-continue behavior, including existing quiescence stopping boundaries.

#### Scenario: Nested cleanup failures reach the default reporter

- **WHEN** native fixture cleanup rejects with nested aggregate members and causes
- **THEN** default reporter output contains each captured inner failure and stack plus process identity/state evidence, without requiring a custom reporter

#### Scenario: Primary and cleanup errors coexist

- **WHEN** the body or pending submission rejects and finally cleanup also fails
- **THEN** both failures are observable rather than only the cleanup failure
- **AND** when cleanup succeeds a body failure remains the same error object

#### Scenario: Diagnostic capture preserves each existing cleanup boundary

- **WHEN** quiescence fails at an existing stopping boundary, including either early stop in the spawn/identity fault test
- **THEN** failure-time diagnostics include captured primary/pending evidence and later cleanup remains unexecuted
- **AND** existing collect-and-continue cleanup surfaces retain their current continuation behavior and order
- **AND** failure to capture ps evidence reports unavailability without suppressing or replacing the original error

#### Scenario: Ordinary cleanup and known root cause remain unchanged

- **WHEN** normal cleanup succeeds or the previously fixed one-shot startup identity fault is exercised
- **THEN** existing cleanup order and assertions are preserved without new diagnostic ps calls on success, production ownership changes or shared-default changes

### Requirement: Native settlement tests observe completion prerequisites

Native tests that consume settlement results or collect a completed run SHALL wait for the required observable completion state with a bounded deadline while driving accepted registry work. A single joined tick SHALL NOT be treated as proof of settlement. Isolation tests SHALL continue to assert protected entries remain unchanged on every waiting iteration. Production dispatch semantics and all existing outcome, identity and evidence assertions SHALL remain unchanged.

#### Scenario: Joined work returns before settlement

- **WHEN** an accepted step returns before observing newly published exit evidence
- **THEN** the test continues driving and waiting for completion before reading settlement results or collecting
- **AND** every iteration retains bad-entry immutability and non-completion assertions where applicable
- **AND** permanent non-completion produces a bounded, site-identifying timeout rather than bypassing assertions or retrying collection

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
