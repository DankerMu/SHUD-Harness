# Review report -- PR #48 observable 215d635 invariant-state

Reviewer agent: review-invariant-state
Review round: follow-up observable 215d635
Reviewed head SHA: 215d635e8edc6c4e5db3af8b833cf377fdda02cc

Summary:
Not clean; raw-byte authority is improved, but two evidence/state identity paths can still emit misleading raw-denial telemetry.

Invariant Matrix Coverage:
- Producers: partially covered - `RawDataSandboxedBashTool` now owns sandbox/advisory evidence, but outer `RAW_DATA_WRITE_RULE_ID` composition can still collapse sibling root identity.
- Validators/preflight: partially covered - bounded observable attribution exists, but target-name denial text can still be user-forged and upgraded.
- Storage/cache/query: covered - audit reservation/path identity checks protect the audit file before append.
- Entrypoints: covered - SHUD runtime replaces `bash` with the sandboxed wrapper and keeps Zero source unchanged.
- Consumers: covered - raw denial payload, audit row, and WS `tool.failed` input are generated from the same payload shape.
- Failure paths/stale-state: partially covered - audit failures and running metadata are covered; false observable-denial attribution remains.
- Sibling identity: missing - outer raw deny has only `ruleId`, no matched protected-root identity, so sibling roots can be conflated.
- Backward compatibility: covered - generic `policy_gate_denied` remains available for non-raw or unattributed outer denies.
- Evidence surfaces: partially covered - payload/audit/WS agree after evidence is built, but evidence can still be built for forged or mismatched inputs.

Findings:

1. Severity: P1
   Failure class: observable-denial evidence / false attribution.
   Violated invariant/contract: `raw_data_write_denied` must be emitted only for observable sandbox/advisory denial evidence attributable to an actual protected raw mutation attempt; hidden/suppressed denials and user-forged denial text must not be presented as observed OS denial.
   Concrete scenario: With advisory disabled, run `if false; then printf nope > data/raw/dead-branch.txt; fi; printf 'data/raw/dead-branch.txt: Permission denied\n' >&2; true`. No raw write is attempted, but `collectObservableRawMutationTargets()` still collects the dead-branch target, `observableSandboxDenialLines()` accepts the forged line, and `lineMentionsTarget()` matches the target string/basename, so the wrapper can return `raw_data_write_denied` and append `decision=denied_by_sandbox`.
   Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3579`, `packages/core/src/tools/raw-data-sandbox.ts:3588`, `packages/core/src/tools/raw-data-sandbox.ts:3593`, `packages/core/src/tools/raw-data-sandbox.ts:3662`, `packages/core/src/tools/raw-data-sandbox.ts:3673`, `packages/core/src/tools/raw-data-sandbox.ts:3693`.
   Consequence: ToolResult, audit row, and WS-compatible evidence can falsely claim an OS sandbox denial for a non-executed or suppressed raw mutation.
   Fix direction: Tighten post-exec attribution so generic/user-controlled denial lines cannot satisfy evidence by merely naming a collected target; remove or narrow basename fallback.
   Required test/proof: Add regressions for dead-branch raw target plus target-named denial text and suppressed raw denial plus target-named unrelated denial text; assert no `raw_data_write_denied`, no `denied_by_sandbox` audit, unchanged raw bytes, and retained true visible raw-denial positives.
   Sibling surfaces: shell control-flow branches, `|| true` normalization, interpreter stderr suppression, over-budget prefix attribution, symlink target attribution, audit row builder, WS event builder.
   Blocking status: yes, candidate blocking P1.

2. Severity: P1
   Failure class: evidence/audit identity collapse across sibling protected roots.
   Violated invariant/contract: Raw-denial evidence must carry profile/root identity for the protected root that actually caused the raw rule denial; identity must not collapse across sibling or mismatched raw roots.
   Concrete scenario: The outer evaluator is configured with `createRawDataWriteAdvisoryRule([outerRawRoot])`, while the sandboxed bash tool protects `fixture.rawRoot`. A command such as `printf nope > <outerRawRoot>/outer.txt; if false; then printf nope > data/raw/inner.txt; fi` is denied by the outer root rule. Because the adapter only sees `ruleId="raw-data-write"` and then re-runs the inner advisory against the command text, `canAttributeOuterRawPolicyGateDeny()` can return true from the inner dead-branch target and emit `raw_data_write_denied` with the sandbox profile for `fixture.rawRoot`, even though the outer deny was for the sibling root.
   Evidence: `packages/core/src/tools/policy-gate-core.ts:32` shows `PolicyGateDecision` carries no matched-root identity; `packages/core/src/tools/policy-gate-registry.ts:250` delegates any `RAW_DATA_WRITE_RULE_ID` deny to the inner raw evidence path when `canAttributeOuterRawPolicyGateDeny()` returns true; that helper only re-evaluates command text against inner protected roots at `packages/core/src/tools/raw-data-sandbox.ts:506`; the mismatch regression at `packages/core/src/tools/policy-gate-registry.test.ts:370` covers only a command with no inner raw sibling.
   Consequence: Audit and WS evidence can report the wrong `profile_id`/protected-root authority for a denial, weakening provenance and downstream remediation identity.
   Fix direction: Carry matched protected-root/profile identity in raw policy decisions, or only allow outer raw-denial composition when the wrapper owns both the evaluator and the same protected root set. Otherwise return generic `policy_gate_denied`.
   Required test/proof: Add a mismatched-root outer deny with an additional inner raw dead-branch/static sibling target; assert it remains generic with no sandbox profile identity or audit row. Keep matching-root outer deny coverage for `raw_data_write_denied`.
   Sibling surfaces: custom `evaluate` callers, multi-root raw policies, spawn-scoped registries, generic `wrapToolWithPolicyGate`, audit row/profile identity, WS projection.
   Blocking status: yes, candidate blocking P1.

Non-blocking notes:
- `isLikelySandboxDenial(output)` remains exported as a broad output-only helper, but no current consumer was found in this diff.

Execution Summary: agents=review-invariant-state; skills=review; tools=git, rg, sed, nl, find; verification=read-only diff/code/test-context review, no tests run; limits=no edits/commits/push, no nested agents.
