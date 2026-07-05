# Review report -- PR #48 observable 067e544 integration

Reviewer agent: review-integration
Review round: follow-up observable 067e544
Reviewed head SHA: 067e544368f88ec60922a243f1bcf6597f211489

Summary:
The follow-up closes the prior raw-deny bypass, `innerTool` ambiguity, CI skip, output cap, and process-sampling issues at the main paths. Two candidate integration gaps remain: one P1 observable-denial contract hole for over-budget but visibly denied raw writes, and one P2 profile identity coherence issue for mismatched outer raw policy roots.

Invariant Matrix Coverage:
- Covered: raw byte authority, six escape classes, hidden-denial no-false-telemetry boundary, registry outer raw deny no inner bash execution, `innerTool` rejection, output truncation, running metadata, timeout/abort cleanup, waited foreground subprocess.
- Gap: visible raw denial classification is too coarse when command analysis budget is exceeded.
- Gap: outer raw deny can emit a `profile_id` for a sandbox profile that does not correspond to the outer policy root that caused the denial.

Findings:

1. Severity: P1
   Failure class: observable-denial evidence / audit contract under bounded analysis fallback.
   Violated invariant/contract: Observable OS raw-write denials must return remediation-shaped tool errors and produce `tool.failed`/audit evidence when the raw target is tied to the denial; budget overflow must not erase visible denial telemetry.
   Concrete scenario: `printf nope > data/raw/over-budget-visible.txt # ${"x".repeat(140000)}` is over `COMMAND_ANALYSIS_MAX_LENGTH`; seatbelt visibly denies the raw write, but the classifier returns `false` before checking output or bounded target evidence, so the wrapper records generic `decision="failed"` instead of `denied_by_sandbox`.
   Evidence: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25`, `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:34`, `packages/core/src/tools/raw-data-sandbox.ts:3565`, `packages/core/src/tools/raw-data-sandbox.ts:440`. `packages/core/src/tools/raw-data-sandbox.test.ts:2936` covers unrelated over-budget permission text but not visible over-budget raw write.
   Consequence: Users and downstream WS/audit consumers see a generic bash failure without `ErrorRecord.remediation`, `denied_by_sandbox`, or raw policy evidence even though the OS sandbox visibly blocked a protected raw mutation.
   Fix direction: Keep the false-positive fix, but add a bounded positive path: if denial output is visible and a cheap bounded scan proves a raw write target before/within budget, emit `raw_data_write_denied`; otherwise keep generic failure.
   Required test/proof: Add an over-budget visible raw-write regression asserting `raw_data_write_denied`, `decision=denied_by_sandbox`, audit/WS evidence, and no raw mutation; retain the over-budget raw-read/unrelated-permission generic-failure test.
   Sibling surfaces: `isLikelySandboxDenialForCommand`, symlink target resolution, audit row generation, backend `tool.failed` skeleton input, long generated shell/R/Python commands.
   Blocking status: Blocking candidate P1.

2. Severity: P2
   Failure class: ToolResult/audit/WS identity and profile provenance coherence.
   Violated invariant/contract: Raw-denial ToolResult, audit, and WS evidence must carry coherent rule/profile identity; `profile_id` should identify the profile governing the same protected root set as the denial being reported.
   Concrete scenario: The registry can be configured with sandbox `protectedRawPaths=[fixture.rawRoot]` while the outer policy evaluator denies `createRawDataWriteAdvisoryRule([outerRawRoot])`. The outer deny does not execute bash, but `denyByOuterRawPolicyGate()` rebuilds a profile from the sandbox protected roots, then propagates that unrelated `profile_id` into payload/audit/WS evidence for the outer-root denial.
   Evidence: `packages/core/src/tools/policy-gate-registry.ts:250`, `packages/core/src/tools/raw-data-sandbox.ts:466`, `packages/core/src/tools/raw-data-sandbox.ts:776`, `packages/core/src/tools/raw-data-sandbox.ts:852`, `packages/backend/src/ws/index.ts:43`, `packages/core/src/tools/policy-gate-registry.test.ts:370`.
   Consequence: Evidence consumers can trust that ToolResult/audit/WS agree with each other, but not that the `profile_id` actually corresponds to the raw root that caused the denial.
   Fix direction: Ensure raw advisory rules used by the runtime are derived from the same sandbox protected roots, reject/flag mismatched external `raw-data-write` rules, or extend the denial evidence with the policy root fingerprint and avoid profile attribution when no matching profile was applied.
   Required test/proof: Add a mismatch regression that either fails registry construction or asserts the denial evidence cannot emit an unrelated `profile_id`; include payload, audit row, and WS event checks.
   Sibling surfaces: `createShudRuntimeToolRegistry`, `createRawDataWriteAdvisoryRule`, `denyByOuterRawPolicyGate`, audit rows, `rawDataDenialPayloadToToolFailedEventInput`, backend WS event builder.
   Blocking status: Non-blocking candidate P2, but should be fixed or explicitly constrained before treating profile identity as audit evidence.

Non-blocking notes:
Read-only review only; tests were not rerun by this reviewer.

Execution Summary: agents=review-integration; skills=review protocol only; tools=exec_command, rg, sed, git; verification=read-only diff and context inspection; limits=no edits, no commits, no pushes, no nested agents.
