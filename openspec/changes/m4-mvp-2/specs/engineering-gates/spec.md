# Spec Delta

## MODIFIED Requirements

### Requirement: Scientific wording rules are enforced by tested constants

The scientific wording rules SHALL be enforced by the forbidden-report-phrase and governance-invariant constants exported from the core governance wording module, pinned by positive and negative tests in the default `pnpm run test` gate. The `constraints.yaml` review-only entry for scientific wording rules SHALL be removed and replaced by a verification row backed by `pnpm run test`; the rendered Enforcement Index SHALL list the wording rule at block level instead of review-only. The rendered instruction files SHALL be produced from the instructions source through `pnpm run instructions:render`, not edited by hand. No profile override of the wording constants SHALL exist. The gate wording "措辞过四条不变式" SHALL mean exactly: the four `GOVERNANCE_INVARIANTS` sentences appear verbatim in the report Markdown, and no forbidden report phrase appears in the model-authored report fields; semantic compliance with the invariants is not machine-checked and remains the PI's review, and no gate, report or document SHALL present a passing wording check as proof of compliance.

The same wording module SHALL also export, as a single constant, the fixed `code_change` report §5 sentence "本里程碑无指标 artifact；验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。" The report template SHALL render §5 of every `code_change` report from that constant verbatim, and SHALL NOT render it into reports of other task types. The constant SHALL be pinned by tests in the default `pnpm run test` gate and SHALL have no profile override or hand-written second source. Its verbatim presence is a machine-checkable wording fact only; it SHALL NOT be presented as proof of parallel correctness, performance or model improvement.

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

#### Scenario: code_change §5 sentence comes from the tested constant

- **WHEN** a `code_change` report is generated and the default `pnpm run test` gate runs
- **THEN** the report §5 contains the exported `code_change` §5 constant verbatim, and a test asserts that equality against the constant rather than a hand-written copy

#### Scenario: Altered or misplaced §5 sentence is rejected

- **WHEN** the template renders a `code_change` §5 that differs from the constant by any character, or renders the constant into a `science_assist` report
- **THEN** the wording tests fail and `pnpm run test` exits nonzero

## ADDED Requirements

### Requirement: System make is declared as a build prerequisite

The repository SHALL declare the exact external binary `make` in the existing Knip `ignoreBinaries` list for M4 shud_build and its real-Makefile integration tests. It SHALL document system make as a non-npm prerequisite in canonical agent instruction sources and generate the instruction projections through the existing renderer. It SHALL NOT replace the actual make command, install an npm substitute, disable the unlisted-binary check, or add broad ignore patterns.

#### Scenario: Required system make is recognized without hiding unrelated binaries

- **WHEN** Knip analyzes the registered make invocation with the repository's external-binary declaration
- **THEN** make is not reported as unlisted, while an unrelated undeclared executable still fails the same check

#### Scenario: Tool prerequisite is documented and rendered

- **WHEN** instructions:render and the instruction drift check run
- **THEN** the canonical prerequisite and both generated instruction files state that shud_build and its integration tests require system make, not an npm dependency


### Requirement: Replay local gate is registered

The repository SHALL provide `pnpm run shud:replay <scratch-workspace>`, a local blocking gate for the known-answer replay. It SHALL take the scratch workspace path as an explicit argument; a missing argument SHALL exit nonzero before any session starts. It SHALL require `DMXAPI_KEY`, `SHUD_BIN`, `SUNDIALS_ROOT` and `SHUD_REPLAY_KELIYA`; any missing prerequisite SHALL exit nonzero before workspace preparation and before any session starts, naming the missing item, and SHALL NOT skip. Its pass and fail criteria SHALL be taken from the session log and workspace files, not from model text.

It SHALL exit 0 only when every criterion of known-answer-replay「Replay acceptance criteria」holds (that requirement is the single source of the pass/fail list; this gate restates none of it), and it SHALL exit 1, keeping the workspace and session log, when any criterion fails or the VerificationCase is `failed`.

The gate's automatic Allow once is engineering evidence only and SHALL NOT substitute for the Epic-close PI acceptance. The gate SHALL be registered as block (local) in the rendered Verification Matrix and Enforcement Index and in the `constraints.yaml` verification mirror, SHALL be listed with `shud:tiny`, `shud:restart` and `shud:first-task` among the local-only gates that CI cannot run, and `Test_Fixtures_And_Command_Matrix` SHALL record the keliya replay fixture (its explicit source path, the two preparation-time rewrites and the out-of-workspace forcing reference).

#### Scenario: Passing replay exits 0

- **WHEN** `pnpm run shud:replay` runs with an explicit scratch workspace path, `DMXAPI_KEY`, `SHUD_BIN`, `SUNDIALS_ROOT` and `SHUD_REPLAY_KELIYA`, and the replay produces a `passed` VerificationCase with all other criteria satisfied
- **THEN** it exits 0, citing the session log approval events and the workspace change, build, run, verification, task and report files as evidence

#### Scenario: Failed verification exits 1 and retains evidence

- **WHEN** the replay completes but the VerificationCase has `status: failed`
- **THEN** it exits 1, prints the retained workspace and session log paths, and does not classify the run as INCONCLUSIVE

#### Scenario: Missing prerequisite fails before the session

- **WHEN** `pnpm run shud:replay` runs without a scratch workspace path, or with any of `DMXAPI_KEY`, `SHUD_BIN`, `SUNDIALS_ROOT` or `SHUD_REPLAY_KELIYA` unset
- **THEN** it exits nonzero before preparing the workspace or starting dsh and names the missing item

#### Scenario: Missing acceptance evidence fails

- **WHEN** the replay ends with two approved ChangeRequests, a single BuildRecord, a RunJob without `threads: 1`, a moved `repos/SHUD` HEAD, or a report missing the `code_change` §5 sentence
- **THEN** it exits nonzero and names the failed criterion

#### Scenario: Gate is registered as local block

- **WHEN** the Verification Matrix, Enforcement Index, `constraints.yaml` and `Test_Fixtures_And_Command_Matrix` are inspected
- **THEN** `pnpm run shud:replay <scratch-workspace>` appears as a local blocking gate requiring `DMXAPI_KEY`, `SHUD_BIN`, `SUNDIALS_ROOT` and `SHUD_REPLAY_KELIYA`, the keliya replay fixture is recorded, and CI configuration does not claim to run it

### Requirement: New core objects participate in schema drift gate

The ChangeRequest, VerificationCase and BuildRecord Zod schemas SHALL live in `packages/dsh-shud-core/src/schemas/`, SHALL be registered in the schema generation registry, and SHALL be projected to Markdown and JSON Schema under `docs/generated/` by `pnpm run schema:generate`. The semantic-level floor constants (the path-to-floor table, the level order and the level-to-risk mapping) SHALL likewise be projected under `docs/generated/` by the same command. `pnpm run schema:check`, part of the default `pnpm run check`, SHALL fail whenever any of these schemas or constants differs from its committed projection. The projections SHALL NOT be edited by hand, and no profile or runtime override of the floor constants SHALL exist.

#### Scenario: Generate produces the new projections

- **WHEN** `pnpm run schema:generate` runs
- **THEN** `docs/generated/` contains Markdown and JSON Schema projections of ChangeRequest, VerificationCase and BuildRecord, and a projection of the semantic-level floor constants

#### Scenario: Branded ids reject the legacy sequence form

- **WHEN** the generated ChangeRequest, VerificationCase and BuildRecord projections are inspected
- **THEN** their id patterns accept `CHG-`, `VC-` and `BUILD-` ids of the form `<prefix>-YYYYMMDDTHHMMSS-xxxx` and reject `CHG-0001`

#### Scenario: Schema change without regeneration fails

- **WHEN** a field is added to the ChangeRequest, VerificationCase or BuildRecord schema without running `pnpm run schema:generate`
- **THEN** `pnpm run schema:check` exits nonzero and `pnpm run check` fails

#### Scenario: Floor table change without regeneration fails

- **WHEN** an entry of the semantic-level floor table is changed without running `pnpm run schema:generate`
- **THEN** `pnpm run schema:check` exits nonzero and names the drifted projection
