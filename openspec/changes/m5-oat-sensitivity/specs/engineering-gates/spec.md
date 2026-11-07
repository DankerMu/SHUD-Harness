# Spec Delta

## MODIFIED Requirements

### Requirement: New core objects participate in schema drift gate

The ChangeRequest, VerificationCase, BuildRecord and AnalysisPlan Zod schemas SHALL live in `packages/dsh-shud-core/src/schemas/`, SHALL be registered in the schema generation registry, and SHALL be projected to Markdown and JSON Schema under `docs/generated/` by `pnpm run schema:generate`. The semantic-level floor constants (the path-to-floor table, the level order and the level-to-risk mapping) SHALL likewise be projected under `docs/generated/` by the same command. `pnpm run schema:check`, part of the default `pnpm run check`, SHALL fail whenever any of these schemas or constants differs from its committed projection. The projections SHALL NOT be edited by hand, and no profile or runtime override of the floor constants SHALL exist.

#### Scenario: Generate produces the new projections

- **WHEN** `pnpm run schema:generate` runs
- **THEN** `docs/generated/` contains Markdown and JSON Schema projections of ChangeRequest, VerificationCase, BuildRecord and AnalysisPlan, and a projection of the semantic-level floor constants

#### Scenario: Branded ids reject the legacy sequence form

- **WHEN** the generated ChangeRequest, VerificationCase, BuildRecord and AnalysisPlan projections are inspected
- **THEN** their id patterns accept `CHG-`, `VC-`, `BUILD-` and `PLAN-` ids of the form `<prefix>-YYYYMMDDTHHMMSS-xxxx` and reject `CHG-0001` and `PLAN-0001`

#### Scenario: Schema change without regeneration fails

- **WHEN** a field is added to the ChangeRequest, VerificationCase, BuildRecord or AnalysisPlan schema without running `pnpm run schema:generate`
- **THEN** `pnpm run schema:check` exits nonzero and `pnpm run check` fails

#### Scenario: Floor table change without regeneration fails

- **WHEN** an entry of the semantic-level floor table is changed without running `pnpm run schema:generate`
- **THEN** `pnpm run schema:check` exits nonzero and names the drifted projection


## ADDED Requirements

### Requirement: Sensitivity local gate is registered

The repository SHALL provide `pnpm run shud:sensitivity <scratch-workspace>`, a local blocking gate for the M5 one-at-a-time sensitivity batch. It SHALL take the scratch workspace path as an explicit argument and SHALL NOT check or reject a path under `$TMPDIR`; a missing argument SHALL exit nonzero before any session starts. It SHALL require an absolute executable regular-file `SHUD_BIN`, a nonempty `DMXAPI_KEY` and the `SHUD/input/ccw` source inputs; any missing prerequisite SHALL exit 1 before workspace preparation and before any session starts, naming the missing item, and SHALL NOT skip or fall back. Because the headless template has no approval cards, it SHALL drive the batch through a Web-template profile and its HTTP interface. Its pass and fail criteria SHALL be taken from the session log and workspace files, not from model text.

It SHALL exit 0 only when every criterion of oat-sensitivity「Sensitivity acceptance criteria」holds (that requirement is the single source of the pass/fail list; this gate restates none of it). It SHALL exit 2 (INCONCLUSIVE) only in the model-deviation case that requirement defines — the linked plan is not equivalent to the fixed acceptance plan while governance and preservation evidence is clean — and SHALL exit 1, keeping the workspace and session log, for any other failed criterion, including a baseline-repeat rivqdown sha256 mismatch.

The gate's automatic Allow once is engineering evidence only and SHALL NOT substitute for the Epic-close PI acceptance. The gate SHALL be registered as block (local) in the rendered Verification Matrix and Enforcement Index and in the `constraints.yaml` verification mirror, SHALL be listed with `shud:tiny`, `shud:restart`, `shud:first-task` and `shud:replay` among the local-only gates that CI cannot run, and `Test_Fixtures_And_Command_Matrix` SHALL record the ccw sensitivity fixture (source `SHUD/input/ccw`, the 90-day window and the fixed four-parameter-set plan). The rendered instruction files SHALL be produced from `instructions/agents/shared.md` through `pnpm run instructions:render`, within the existing rendered instruction byte and line budgets.

#### Scenario: Passing sensitivity batch exits 0

- **WHEN** `pnpm run shud:sensitivity` runs with an explicit scratch workspace path, `SHUD_BIN` and `DMXAPI_KEY`, and the batch satisfies every acceptance criterion
- **THEN** it exits 0, citing the session log approval events and the workspace task, analysis, run, metrics, summary and report files as evidence

#### Scenario: Model deviation exits 2

- **WHEN** the model builds a plan that is not equivalent to the fixed acceptance plan and the approval and preservation evidence is clean
- **THEN** it exits 2, reports INCONCLUSIVE and the deviating parameter sets, and retains the workspace and session log

#### Scenario: Repeat mismatch exits 1

- **WHEN** the out-of-batch baseline repeat produces a rivqdown sha256 different from the in-batch baseline
- **THEN** it exits 1, prints both sha256 values and the retained workspace and session log paths, and does not classify the run as INCONCLUSIVE

#### Scenario: Missing prerequisite fails before the session

- **WHEN** `pnpm run shud:sensitivity` runs without a scratch workspace path, or with `SHUD_BIN` or `DMXAPI_KEY` unset
- **THEN** it exits nonzero before preparing the workspace or starting dsh and names the missing item

#### Scenario: Gate is registered as local block

- **WHEN** the Verification Matrix, Enforcement Index, `constraints.yaml` and `Test_Fixtures_And_Command_Matrix` are inspected
- **THEN** `pnpm run shud:sensitivity <scratch-workspace>` appears as a local blocking gate requiring `SHUD_BIN` and `DMXAPI_KEY`, the ccw sensitivity fixture is recorded, CI configuration does not claim to run it, and the instruction render check reports no drift

### Requirement: rSHUD cross-check generator is local-only

The one-time local script that produces the committed rSHUD water-balance cross-check expectations (`scripts/metrics/rshud-crosscheck.R`, requiring `Rscript` and rSHUD 2.5.0) SHALL NOT be invoked by `pnpm run check`, any CI job or any runtime package, and R SHALL NOT become a runtime, test or install dependency. The default `pnpm run test` gate SHALL compare the TypeScript metric results against the committed expectation JSON next to the fixture without R. The script header SHALL record the R, rSHUD and xts versions and the generation command. Regenerating the expectations is a local, reviewed act; tests SHALL NOT regenerate or rewrite the committed expectation bytes. Documentation that cites rSHUD source paths for the formula SHALL remain subject to the existing documentation path checks, and this requirement SHALL NOT change those checker rules or the rSHUD pin.

#### Scenario: Default gate runs without R

- **WHEN** `pnpm run check` runs on a machine without `Rscript`
- **THEN** the cross-check comparison tests run against the committed expectation JSON and pass or fail on the TypeScript result alone, and no step invokes R

#### Scenario: CI does not run the generator

- **WHEN** `.github/workflows/`, root `package.json` scripts and the runtime packages are inspected
- **THEN** none invokes `scripts/metrics/rshud-crosscheck.R` or declares an R dependency

#### Scenario: Stale citation is still caught

- **WHEN** a documentation file cites a nonexistent rSHUD water-balance source path while the rSHUD root is initialized
- **THEN** the existing documentation path check exits nonzero with the offending citation
