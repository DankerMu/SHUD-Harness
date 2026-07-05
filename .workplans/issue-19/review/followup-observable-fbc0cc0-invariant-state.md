# Review report -- PR #48 observable fbc0cc0 invariant-state

Reviewer agent: review-invariant-state
Review round: follow-up observable fbc0cc0
Reviewed head SHA: fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48

Summary:
Runtime invariant fixes look aligned; one P2 contract-drift candidate remains in OpenSpec telemetry wording.

Invariant Matrix Coverage:
- Governing raw-byte invariant: covered.
- Producer boundary: covered - raw-denial payloads are produced only by sandbox tool advisory path; post-exec sandbox process results are generic lifecycle rows.
- Wrapper/custom evaluator identity: covered.
- Evidence/audit/WS: covered in code, missing in docs - OpenSpec still states broader sandbox-denial telemetry.
- Failure paths/stale state: covered.
- Sibling roots and basename/symlink attribution: covered.
- Over-budget/static advisory fail-open: covered.
- Backward compatibility: covered.
- Repeated unsafe helper pattern: covered in current call paths.
- Out-of-scope: hidden OS denial telemetry and future trusted OS event source are correctly not implemented in this M1 slice.

Findings:
- Severity: P2
  Failure class: specification/observable-contract drift.
  Violated invariant/contract: Accepted telemetry invariant says post-exec process output alone must remain generic lifecycle evidence, and raw-denial identity must not be inferred from ambiguous visible output.
  Concrete scenario: A future implementer follows OpenSpec text saying observable OS denials should produce `decision=denied_by_sandbox`, then reintroduces output-based matching for forged output, contradicting new regressions that require generic `failed`.
  Evidence: `openspec/changes/m1-foundation/design.md:146`, `design.md:178`, `design.md:189`, `design.md:199`, `openspec/changes/m1-foundation/tasks.md:33`; current code/tests intentionally do generic lifecycle.
  Consequence: Canonical change text can drive downstream reviewers or later WS/audit work to recreate false raw-denial attribution or mark runtime behavior non-compliant.
  Fix direction: Update OpenSpec/design/task wording so M1 raw-denial payloads are limited to trusted advisory/static evidence inside the sandbox tool; sandbox execution failures observed only through process result/audit lifecycle remain `allowed`/`failed` with profile metadata unless a future trusted OS event source is added.
  Required test/proof: Add doc/grep proof showing no active OpenSpec text claims process-output-visible OS denials must emit `denied_by_sandbox`; keep regression suite green.
  Sibling surfaces: OpenSpec spec lines, backend synthetic `denied_by_sandbox` payload test, exported payload builder.
  Blocking status: candidate blocker for OpenSpec truth-source closure; not a raw-byte enforcement regression.

Non-blocking notes:
- Broad `isLikelySandboxDenial(output)` remains exported with no current consumer; keeping it internal or documenting as non-authoritative would reduce future misuse.
- WS test fabricates a `denied_by_sandbox` payload; acceptable if reserved for a future trusted OS event source, but the test name is now misleading.

Execution Summary: agents=review-invariant-state; skills=review; tools=git diff/status/log/rev-parse/diff --check, rg, sed, nl; verification=static diff and call-chain review only; limits=read-only, no edits/tests/subagents.
