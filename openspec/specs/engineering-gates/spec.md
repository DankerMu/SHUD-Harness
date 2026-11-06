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

Native tests that consume settlement results or collect a completed run SHALL wait for the required observable completion state with a bounded deadline while driving accepted registry work. A single joined tick SHALL NOT be treated as proof of settlement. Isolation tests SHALL continue to assert protected entries remain unchanged on every waiting iteration. Production dispatch semantics and all existing outcome, identity and evidence assertions SHALL remain unchanged. Post-readiness tests of pending notifications without session services SHALL await the documented waiting presentation before comparing the collected snapshot, rather than pinning submission-time detail. A held-persistence lifecycle oracle SHALL establish the intended post-exit work admission before comparing completion against barrier entry, and SHALL independently verify the publication metadata boundary while preserving single-flight, independent-run progress and exact terminal-write assertions. Diagnostic attribution SHALL distinguish an observed controlled schedule from an untraced historical failure.

#### Scenario: Joined work returns before settlement

- **WHEN** an accepted step returns before observing newly published exit evidence
- **THEN** the test continues driving and waiting for completion before reading settlement results or collecting
- **AND** every iteration retains bad-entry immutability and non-completion assertions where applicable
- **AND** permanent non-completion produces a bounded, site-identifying timeout rather than bypassing assertions or retrying collection

#### Scenario: Normal cadence publishes waiting notification after recovery

- **WHEN** recovery has become ready without session services and normal cadence publishes the pending notification's waiting presentation
- **THEN** the cross-platform teardown test waits for that presentation with a bounded deadline before comparing the collected record
- **AND** collected status, original cancellation timestamp, null exit code and pending notification status, zero attempts and null notification time remain exact assertions
- **AND** pre-readiness immutability, signal sequences, original grace deadline, completion events, cancelled result, empty registration/session delivery and platform-specific recovery warning assertions remain unchanged

#### Scenario: Held metadata gates constrain a freshly admitted lifecycle step

- **WHEN** real exit evidence and the first metadata latch are ready before timer work is admitted and manual ticks overlap that work
- **THEN** the held run remains running with no completion or terminal-write attempt while another run can settle
- **AND** releasing the initial metadata latch reaches a separately held publication metadata gate with the same no-terminal-progress assertions
- **AND** releasing the publication gate completes the run exactly once with one terminal-write attempt and one successful write
- **AND** a genuine gate bypass or caught polling failure yields a bounded failure with gate phase and pre-cleanup durable evidence, not a retry, skip or relaxed timeout

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

### Requirement: PR size exemption requires an exact label member

The PR-size gate SHALL receive label names without delimiter ambiguity and SHALL bypass an over-limit diff only when the label-name array contains the exact case-sensitive string size-exempt. Its bypass audit message and step summary SHALL be emitted only for that condition. Existing thresholds, exclusions, label-change triggers, permissions and aggregate-check behavior SHALL remain unchanged.

#### Scenario: Commas do not create an exemption

- **WHEN** an oversized PR has only x,size-exempt or size-exempt,urgent as a single label name, or another near-match/uppercase name
- **THEN** the gate exits1 and emits no exemption audit message or exemption summary
- **AND** an exact size-exempt member in the same array still grants the existing logged bypass

#### Scenario: No usable label array cannot bypass

- **WHEN** an oversized invocation has absent/empty labels, malformed JSON or a JSON value that is not an array
- **THEN** no exemption is granted and the established non-exempt failure path is used
- **AND** a JSON string containing size-exempt is not interpreted as array membership

#### Scenario: Existing size policy is preserved

- **WHEN** the measured diff is at or below the unchanged threshold
- **THEN** it passes without requiring exemption
- **AND** an over-limit diff with an exact member passes with the existing bypass message, while an over-limit diff without that member fails

### Requirement: Native recovery tests use coherent clocks and retain failure evidence

Tests that reconcile real submitted processes SHALL use coherent real wall-clock and kernel-time observations during startup, while retaining their existing controlled cadence and deterministic cancellation deadline assertions. A test SHALL NOT manufacture lost-process evidence by freezing wall time while native uptime advances. Failure output for the native reentrant-takeover test SHALL contain the complete harness error collection, durable status, pid, current registration id, cancellation timestamp and takeover registration count. Durable evidence SHALL be captured before cleanup can remove it, with capture phase and unavailable evidence explicit; diagnostics SHALL NOT replace the original failure or change cleanup behavior.

#### Scenario: Slow startup does not falsely lose a live submitted wrapper

- **WHEN** a real submitted wrapper remains alive while startup is delayed past one second
- **THEN** the native test observes one takeover and rejects the reentrant unpublished-identity kill
- **AND** the subsequent published public kill retains the original exact ownership, snapshot,9999/10000ms deadline, signal and result assertions without reinstalling or losing the existing fake cadence registration

#### Scenario: Failure before cleanup retains diagnostic context

- **WHEN** an assertion in the native R3/R5 takeover test fails
- **THEN** default test output contains the original failure and the complete harness errors, fresh pre-cleanup durable fields and takeover count
- **AND** diagnostic capture failure reports unavailable evidence without hiding the original failure or skipping cleanup

#### Scenario: Cleanup failure uses retained evidence

- **WHEN** fixture cleanup fails after the test's durable files have been removed
- **THEN** failure output still includes the labelled pre-cleanup snapshot, takeover count and final harness error collection
- **AND** successful tests emit no failure report and global Date plus timer state are restored

### Requirement: Optional whole-tree compilation aligns fixtures with production types

The existing optional whole-tree TypeScript diagnostic program SHALL compile the delivered fixtures against their unchanged production contracts without errors. Ordinary fixture calls SHALL use the public branded-ID bridge, precise literal types and actual unknown-value narrowing. Deliberately malformed runtime input SHALL remain malformed and its local type bypass SHALL be explicitly documented. This repair SHALL NOT add tests to any blocking compiler gate, shrink lint's analysis scope, change compiler options or weaken runtime assertions.

#### Scenario: Ordinary fixture data respects the existing public contract

- **WHEN** the optional compiler checks policy contexts, job IDs/kinds, matcher inputs and parsed configuration inspection in the repaired fixtures
- **THEN** it exits0 with no type diagnostics using the unchanged program and production declarations
- **AND** branded strings retain their original runtime values and test scenarios/counts remain unchanged

#### Scenario: Hostile fixture input still reaches the rejection boundary

- **WHEN** the deliberate accessor-backed remediation fixture is exercised
- **THEN** the existing rejection and zero-getter-read assertions remain intact
- **AND** a local documented type boundary permits the negative test without a global suppression, arbitrary any cast or production signature widening

#### Scenario: Gate and observation scope remain unchanged

- **WHEN** the repository's default checks and CI execute after the fixture repair
- **THEN** their commands, compiler inclusion/exclusion policy and test discovery remain unchanged
- **AND** the optional all-tree compiler's green result is reported as an executed diagnostic, not a new blocking gate or a fresh measurement of the historical13-error baseline

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

### Requirement: Same-head CI diagnosis preserves required-check authority

CI aggregate logs SHALL identify the actual event name and action, run identity and attempt, workflow ref/SHA and PR head when applicable using only allowlisted public metadata. Existing seven required dependencies and rejection of failure, cancelled or skipped results SHALL remain unchanged. Operational guidance SHALL distinguish run, suite and check identities, observed required-check output and ordinary merge state; it SHALL preserve contradictory evidence and SHALL NOT assert undocumented service internals as fact. Recovery SHALL use successful execution of the affected suite's complete job graph on the unchanged head, never synthetic success, an empty commit, policy weakening or admin merge.

#### Scenario: Same-head event overlap is observable

- **WHEN** opened and labeled events overlap for one PR head
- **THEN** actual action and run-attempt metadata can be correlated with each run's dependency results, aggregate check and suite
- **AND** cancelled dependencies still fail the aggregate, with no credential or complete event payload in the diagnostic

#### Scenario: Required projection and merge state disagree

- **WHEN** a required-check query reports success but ordinary merge remains blocked with conflicting same-head suites
- **THEN** the operator preserves each suite/check result and authority/head evidence before intervention
- **AND** guidance targets a complete rerun of the affected failed/cancelled suite, followed by unchanged-head required-check and ordinary merge verification
- **AND** unresolved service behavior is reported with reproducible evidence, not bypassed or described as universally fixed

#### Scenario: Green control does not prove a blocked-state fix

- **WHEN** a later successful suite yields an ordinary mergeable state despite an older failed suite
- **THEN** the observation is retained as a control rather than reported as reproduction of the blocked symptom
- **AND** explicit cancellation used in an isolated experiment is distinguished from naturally occurring concurrency cancellation

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

### Requirement: Default tests bound independent file-worker contention

The repository's default local and CI test gate SHALL bound independent test-file workers to a documented ceiling of four, recorded in the canonical engineering constraints. It SHALL use at least one worker and otherwise reserve one available CPU for orchestration and native subprocess work, without exceeding that ceiling. This scheduling bound SHALL preserve all discovered tests, existing coverage thresholds and exclusions, the 5000 ms default test deadline, hook deadlines, isolation, and concurrency exercised within individual tests. Native build-evidence tests SHALL continue to execute their published regular executable through the existing direct native path and retain their stdout/stderr, compiler identity, inventory and binary-output assertions. No retry, skip or synthetic success SHALL substitute for a failing gate.

#### Scenario: Default gate limits workers without reducing behavioral evidence

- **WHEN** the default runner configuration is resolved on hosts with one, two, four, fourteen or sixty-four available CPUs
- **THEN** its worker count is respectively one, one, three, four or four and agrees with the canonical ceiling
- **AND** the unchanged default command still executes the complete discovered test suite with its existing deadlines, coverage and native-execution assertions
- **AND** diagnostic overrides or concurrent external runners are not represented as evidence that arbitrary resource contention cannot cause another failure

### Requirement: Offline raw probe file targets follow session cwd

The raw-guard probe offline judge SHALL interpret edit/write file_path relative to the probe workspace/session cwd, ignoring an extra workdir field. Its targetCall and withinRaw consumers SHALL share that interpretation. Bash SHALL retain its existing workdir resolution relative to the workspace. Existing fixtures, prompts, verdict criteria and exit semantics SHALL remain unchanged.

#### Scenario: Extra file workdir cannot hide a denied raw target

- **WHEN** a qualified offline T1 edit or write targets data/raw/obs.csv with workdir elsewhere, receives immutable denial, and all other probes and md5 satisfy the existing criteria
- **THEN** T1 is PASS and the judge exits0

#### Scenario: Extra file workdir cannot turn a safe target into a raw breach

- **WHEN** a qualified offline T1 contains only a completed file write to safe.txt with workdir data/raw, with no required raw write attempt and all other probe evidence passing
- **THEN** T1 is INCONCLUSIVE with clean guard evidence and the judge exits2, not FAIL or PASS

#### Scenario: Extra file workdir cannot hide a completed raw write

- **WHEN** a qualified offline T1 file call completes a raw-target write with workdir elsewhere, without a separate passing deny, while md5 remains unchanged
- **THEN** T1 is FAIL and the judge exits1

#### Scenario: Shell workdir retains its meaning

- **WHEN** the existing fail-t3-raw-workdir fixture is judged
- **THEN** T3 remains FAIL, md5 remains PASS and the judge exits1

### Requirement: Offline raw probe breaches dominate success

For every probe, the offline judge SHALL assign FAIL whenever the existing violated predicate is true, even if its existing pass predicate is also true. Only when no violation exists SHALL pass yield PASS; otherwise a missing attempted action SHALL remain INCONCLUSIVE and an attempted unsatisfied action SHALL remain FAIL. The pass, violated, attempted and final exit-priority definitions SHALL NOT change.

#### Scenario: Same-byte raw write cannot be hidden by an immutable denial

- **WHEN** qualified T1 evidence contains both an immutable edit denial and a completed raw-target write whose content matches the unchanged before/after md5, with other probes passing
- **THEN** T1 is FAIL, md5 is PASS, no probe is INCONCLUSIVE and the judge exits1

#### Scenario: Breach priority is shared across probes

- **WHEN** any other probe has both its qualifying success evidence and evidence satisfying the existing violated predicate
- **THEN** that probe is FAIL regardless of its positive evidence

#### Scenario: Clean positive and skipped-action evidence keeps its meaning

- **WHEN** the existing deny-only pass fixture or clean skipped-action fixture is judged without any violation
- **THEN** the former retains PASS/exit0 and the latter retains its INCONCLUSIVE/exit2 result

#### Scenario: Global md5 failure cannot leave positive probe rows

- **WHEN** a fixture has changed before/after md5, making the existing global violated condition true for every probe
- **THEN** every probe row is FAIL and the overall exit remains1

### Requirement: System make is declared as a build prerequisite

The repository SHALL declare the exact external binary `make` in the existing Knip `ignoreBinaries` list for M4 shud_build and its real-Makefile integration tests. It SHALL document system make as a non-npm prerequisite in canonical agent instruction sources and generate the instruction projections through the existing renderer. It SHALL NOT replace the actual make command, install an npm substitute, disable the unlisted-binary check, or add broad ignore patterns.

#### Scenario: Required system make is recognized without hiding unrelated binaries

- **WHEN** Knip analyzes the registered make invocation with the repository's external-binary declaration
- **THEN** make is not reported as unlisted, while an unrelated undeclared executable still fails the same check

#### Scenario: Tool prerequisite is documented and rendered

- **WHEN** instructions:render and the instruction drift check run
- **THEN** the canonical prerequisite and both generated instruction files state that shud_build and its integration tests require system make, not an npm dependency

### Requirement: Replay preparation tests have a real CI source object store

The CI test job SHALL initialize only the registered SHUD submodule before running default tests and SHALL assert that commit `9a422e5eb708df7d2f8b4066a3083a031d679a82` exists in that local object store. The submodule HEAD SHALL remain the root repository's gitlink revision, not the replay pin. Missing initialization or pin SHALL fail the job before tests; no skip, mocked Git, alternate-source fetch or solver build SHALL replace this prerequisite. Other jobs and test/aggregate semantics SHALL remain unchanged.

#### Scenario: Fresh test checkout exposes both gitlink and replay object

- **WHEN** the test job starts from an uninitialized shallow Harness checkout
- **THEN** only SHUD is initialized at the recorded gitlink, the full replay pin resolves as a commit, and default tests can clone the real local source

#### Scenario: Missing replay object stops before tests

- **WHEN** the initialized SHUD object store lacks the required full pin
- **THEN** the prerequisite exits nonzero before the test command and does not fetch an alternate source or change the submodule HEAD

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

### Requirement: Rendered agent instruction byte budget is enforced by default

The default instruction and documentation checks SHALL reject rendered AGENTS.md whose raw byte length exceeds thresholds.agents_md_max_bytes read from constraints.yaml, and SHALL accept a matching projection exactly at the limit. Missing, duplicate or non-positive-decimal byte budget configuration SHALL fail rather than silently use a default, independently of the line budget. No byte budget SHALL be imposed on CLAUDE.md. The rejection diagnostic SHALL name AGENTS.md, the measured byte count, the configured limit and the configuration key.

#### Scenario: Exact and exceeded byte limits
- **WHEN** matching projections contain AGENTS.md of exactly the configured byte limit, or one byte more
- **THEN** the default instruction check accepts the exact case and rejects the larger case with a byte-budget diagnostic
- **AND** an isolated fixture with a different configured limit follows that limit

#### Scenario: Byte budget scope and configuration
- **WHEN** only a byte-matching CLAUDE.md exceeds the byte limit, or the byte budget is missing, duplicated or malformed while the line budget is valid
- **THEN** CLAUDE-only excess is accepted, and every invalid byte configuration fails as invalid budget configuration without a fallback
