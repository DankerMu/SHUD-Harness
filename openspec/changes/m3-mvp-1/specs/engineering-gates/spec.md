# Spec Delta

## ADDED Requirements

### Requirement: Policy gate core meets the file-size limit without exemptions

The policy-gate-core governance source and its tests SHALL be split by rule family so that every resulting source and test file contains at most 1000 lines. After the split, the `constraints.yaml` baseline SHALL contain no policy-gate-core entries under `max_file_lines`, `eslint_type_safety` or `knip_duplicates`; `.large-file-guard.json` SHALL exclude no policy-gate-core path; and the lint configuration SHALL carry no per-file exemption for policy-gate-core or its tests. The default lint, large-file and check gates SHALL pass on the split files under the unchanged 1000-line limit and type-aware rules, with no replacement exemption added for the new files.

#### Scenario: Split files pass the unchanged limits

- **WHEN** the default check runs after the split
- **THEN** every policy-gate source and test file is at most 1000 lines, lint reports 0 errors and 0 warnings, and the large-file guard accepts a commit touching them
- **AND** `constraints.yaml`, `.large-file-guard.json` and the lint configuration contain no policy-gate-core baseline entry, exclusion or exemption

#### Scenario: Oversized governance file is rejected again

- **WHEN** any split policy-gate file is grown beyond 1000 lines
- **THEN** the default lint gate exits nonzero for that file, as for any other repository file

### Requirement: Duplicate exports block the dead-code gate

The dead-code gate SHALL treat duplicate exports as errors: knip `rules.duplicates` SHALL be `error`, and the `isReservedAuthorityPolicyEvidenceId` alias of `isReservedAuthorityPolicyErrorId` SHALL be removed together with its baseline entry. The default dead-code command SHALL pass on the delivered tree with no duplicate-export suppression.

#### Scenario: Delivered tree has no duplicate exports

- **WHEN** `pnpm run deadcode` runs on the delivered tree
- **THEN** it exits 0 and the removed alias is no longer exported

#### Scenario: New duplicate export fails the gate

- **WHEN** a module exports the same binding under two names
- **THEN** `pnpm run deadcode` exits nonzero and reports the duplicate

### Requirement: Scientific wording rules are enforced by tested constants

The scientific wording rules SHALL be enforced by the forbidden-report-phrase and governance-invariant constants exported from the core governance wording module, pinned by positive and negative tests in the default `pnpm run test` gate. The `constraints.yaml` review-only entry for scientific wording rules SHALL be removed and replaced by a verification row backed by `pnpm run test`; the rendered Enforcement Index SHALL list the wording rule at block level instead of review-only. The rendered instruction files SHALL be produced from the instructions source through `pnpm run instructions:render`, not edited by hand. No profile override of the wording constants SHALL exist. The gate wording "措辞过四条不变式" SHALL mean exactly: the four `GOVERNANCE_INVARIANTS` sentences appear verbatim in the report Markdown, and no forbidden report phrase appears in the model-authored report fields; semantic compliance with the invariants is not machine-checked and remains the PI's review, and no gate, report or document SHALL present a passing wording check as proof of compliance.

#### Scenario: Wording tests run in the default gate

- **WHEN** `pnpm run check` runs
- **THEN** the wording constant tests execute, each forbidden phrase has a rejected example, and an allowed control wording is accepted

#### Scenario: Gate wording states the machine-checkable boundary

- **WHEN** the Phased_Plan M3 gate text and the rendered Enforcement Index entry for the wording rule are inspected
- **THEN** they define "措辞过四条不变式" as verbatim presence of the four invariant sentences plus no forbidden phrase in model-authored fields, and state that semantic compliance stays with the PI

#### Scenario: Control plane no longer lists wording as review-only

- **WHEN** `constraints.yaml` and the rendered Enforcement Index are inspected
- **THEN** the scientific wording rule appears as a tested, blocking rule and not under review-only
- **AND** the instruction render check reports no drift

### Requirement: First-task local gate is registered

The repository SHALL provide `pnpm run shud:first-task`, a local blocking gate that requires local SHUD and `DMXAPI_KEY`. It SHALL take the scratch workspace path as an explicit argument and SHALL NOT check or reject a path under `$TMPDIR`; a missing argument SHALL exit nonzero before any session starts. Because the headless template has no approval cards, it SHALL drive one first task through a Web-template profile and its HTTP interface. It SHALL pass only when the session log contains `approval/asked` and `approval/decided` events for the report submission and the workspace contains a `task.json` with status `done` and a report Markdown file containing `Accepted by PI`, the StackLock llm three fields (`base_url`, `request_alias`, `response_model`) and the three submodule revisions (`SHUD`, `rSHUD`, `AutoSHUD`), and the four governance invariant sentences verbatim; any missing evidence SHALL exit nonzero. The gate SHALL be registered in the rendered Verification Matrix and Enforcement Index and in the `constraints.yaml` verification mirror as block (local), and SHALL be listed with `shud:tiny` and `shud:restart` among the local-only gates that CI cannot run.

#### Scenario: Successful first task passes

- **WHEN** `pnpm run shud:first-task` runs with an explicit scratch workspace path, local SHUD and `DMXAPI_KEY`, and the first task completes with an allowed report submission
- **THEN** it exits 0, citing the session log approval events and the workspace task and report files as evidence

#### Scenario: Missing acceptance evidence fails

- **WHEN** the run ends without `Accepted by PI` in the report Markdown or without a `done` task card
- **THEN** it exits nonzero and names the missing evidence

#### Scenario: Missing workspace argument fails before the session

- **WHEN** `pnpm run shud:first-task` runs without a scratch workspace path
- **THEN** it exits nonzero before starting dsh and names the missing workspace argument

#### Scenario: Gate is registered as local block

- **WHEN** the Verification Matrix, Enforcement Index and `constraints.yaml` are inspected
- **THEN** `pnpm run shud:first-task` appears as a local blocking gate requiring SHUD and `DMXAPI_KEY`, and CI configuration does not claim to run it
