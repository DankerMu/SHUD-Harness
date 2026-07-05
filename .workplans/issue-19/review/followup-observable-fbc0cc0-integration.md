# Review report -- PR #48 observable fbc0cc0 integration

Reviewer agent: review-integration
Review round: follow-up observable fbc0cc0
Reviewed head SHA: fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48

Summary:
Runtime integration now follows the conservative generic-failure strategy, but the OpenSpec source text still describes the removed `denied_by_sandbox` behavior.

Invariant Matrix Coverage:
- Return-value contracts and downstream expectations: missing - implementation/tests now expect runtime sandbox denials to stay generic, while OpenSpec still promises `denied_by_sandbox`.
- Removed-behavior audit: covered - post-exec output attribution and outer raw-rule evidence composition were removed; regressions cover forged target, basename-only, same-basename workspace permission, over-budget forged, and outer mismatch+inner sibling cases.
- Source-of-truth identity across producer/evidence/audit/WS/failure paths: missing - code/test behavior and OpenSpec task/spec/design language disagree on visible OS denial telemetry.
- Wrapper/proxy faithfulness: covered.
- Generic policy-denied compatibility: covered.
- Byte authority boundary: covered by inspected tests.

Findings:
- Severity: P2
  Failure class: source-of-truth drift / removed-behavior contract mismatch.
  Violated invariant/contract: Producer, audit evidence, WebSocket skeleton, and OpenSpec acceptance text must describe one return-value contract for runtime sandbox raw denials.
  Concrete scenario: A later WS/AuditEvent implementer reads OpenSpec and writes a contract test expecting remediation-shaped `raw_data_write_denied`, WS `tool.failed`, and audit `decision=denied_by_sandbox` for a visible seatbelt error. Current code appends generic lifecycle audit `decision="failed"` and returns the raw command failure.
  Evidence: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25`, `spec.md:34`, `openspec/changes/m1-foundation/design.md:42`, `design.md:178`, `openspec/changes/m1-foundation/tasks.md:33`; implementation falls through to generic lifecycle audit in `packages/core/src/tools/raw-data-sandbox.ts`.
  Consequence: The PR leaves two incompatible contracts for the same observable surface.
  Fix direction: Update OpenSpec change/design/task text to state the current M1 contract explicitly: raw byte authority remains in seatbelt; sandbox execution results are generic `allowed`/`failed` unless the sandbox tool's own advisory path denies pre-exec; `denied_by_sandbox` is not emitted from process-output-only attribution in M1 and is reserved for future trusted OS denial evidence.
  Required verification: Add/update documentation/spec consistency proof and keep current forged/same-basename/outer mismatch regressions green.
  Sibling surfaces: `rawDataDenialPayloadToToolFailedEventInput`, backend WS event builder, future AuditEvent schema, M3 AgentActivityFeed, OpenSpec verifiers.
  Blocking status: should be fixed or explicitly deferred before using this OpenSpec change as the acceptance source for #19.

Non-blocking notes:
- Local tests were not rerun in this leaf review.

Execution Summary: agents=review-integration; skills=review; tools=exec_command, multi_tool_use.parallel; verification=static diff/code/test/spec inspection only; limits=leaf reviewer, no edits/tests/subagents.
