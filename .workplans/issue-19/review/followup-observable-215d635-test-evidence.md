# Review report -- PR #48 observable 215d635 test-evidence

Reviewer agent: review-test-evidence
Review round: follow-up observable 215d635
Reviewed head SHA: 215d635e8edc6c4e5db3af8b833cf377fdda02cc

Summary:
The four confirmed 067e544 regressions now have direct coverage, but one adjacent user-forged denial-text boundary remains missing and appears to still permit false `denied_by_sandbox` evidence.

Invariant Matrix Coverage:
- PR head and diff scope: covered - local `HEAD` is `215d635e8edc6c4e5db3af8b833cf377fdda02cc`; reviewed `git diff origin/main...HEAD`.
- Six raw mutation escape classes: covered - runtime tests cover interpreter payload, pipeline/stdin, dynamic target, child/grandchild state, symlink/`../`, rename/unlink in `packages/core/src/tools/raw-data-sandbox.test.ts:81`.
- Observable symlinked raw-dir denial regressions: covered - `mv`, `mkdir`, `rm`, and `ln` through `workspace/raw-link -> ../data/raw` assert `raw_data_write_denied` and unchanged raw bytes at `packages/core/src/tools/raw-data-sandbox.test.ts:183`.
- Symlink-leaf removal negative: covered - removing the workspace symlink itself stays `allowed` and does not emit sandbox-denial audit at `packages/core/src/tools/raw-data-sandbox.test.ts:228`.
- Hidden/suppressed denial no-false-telemetry: mostly covered - generic forged `Permission denied`, suppressed raw denial, hidden interpreter errors, and over-budget hidden writes are covered; target-qualified forged denial text is missing.
- Over-budget visible raw-write denial: covered - bounded-prefix positive now asserts `denied_by_sandbox` at `packages/core/src/tools/raw-data-sandbox.test.ts:3057`; unrelated over-budget permission text remains generic at `packages/core/src/tools/raw-data-sandbox.test.ts:3076`.
- Outer raw deny identity mismatch: covered - mismatched outer raw roots return generic `policy_gate_denied`, avoid bash side effects, avoid audit/profile identity at `packages/core/src/tools/policy-gate-registry.test.ts:370`.
- Matching-root outer raw deny: covered - matching raw advisory denial emits `raw_data_write_denied`/audit identity and does not execute bash side effects at `packages/core/src/tools/policy-gate-registry.test.ts:291` and `packages/core/src/tools/policy-gate-registry.test.ts:330`.
- Legal raw read/workspace write/waited foreground subprocess: covered.
- Hardlink residual and bounded scan: covered.
- WS `tool.failed` skeleton compatibility: covered.
- Zero unchanged: covered.
- GitHub CI status: covered with caveat - PR #48 `check` is green for this head, but Ubuntu skips seatbelt-dependent runtime tests; local macOS run is the real seatbelt evidence.

Findings:
- Severity: P1
  Failure class: evidence/audit false positive / target-qualified forged denial text.
  Violated invariant/contract: Hidden/suppressed or user-forged denial text must not be presented as observed OS sandbox denial; `raw_data_write_denied` / audit `decision=denied_by_sandbox` must be tied to an actual observable raw mutation denial, not merely a syntactic raw target plus forgeable output.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3573` classifies visible denial lines after syntactic command analysis; `packages/core/src/tools/raw-data-sandbox.ts:3593` upgrades when a denial line mentions a collected target; `packages/core/src/tools/raw-data-sandbox.ts:3693` accepts basename-only target matches. Existing negative tests cover generic forged text at `packages/core/src/tools/raw-data-sandbox.test.ts:1147` and `packages/core/src/tools/raw-data-sandbox.test.ts:1172`, but not forged denial lines that include the raw target token or basename.
  Concrete scenario: `if false; then printf nope > data/raw/dead-branch.txt; fi; printf 'dead-branch.txt: Permission denied\n' >&2; false` never executes the raw write branch, but the classifier can collect `data/raw/dead-branch.txt` as a literal write target and then treat the user-printed basename denial line as target-attributed sandbox evidence.
  Consequence: ToolResult, audit, and downstream WS evidence can falsely claim an OS sandbox raw-write denial was observed.
  Fix direction: Tighten post-exec attribution so target-qualified user output from a non-executed or suppressed branch is not enough to emit `denied_by_sandbox`; avoid basename-only attribution unless paired with a stronger raw-path/process diagnostic signal.
  Required verification: Add a seatbelt regression with dead branch or suppressed raw write plus user-printed `data/raw/<target>: Permission denied` and `<target>: Permission denied`; assert no `raw_data_write_denied`, no `denied_by_sandbox` audit, generic failed/allowed result per exit status, and unchanged raw bytes.
  Sibling surfaces: `lineMentionsTarget`, `lineMentionsProtectedRawSignal`, dead branches, suppressed raw redirections, dynamic raw variables, interpreter try/catch, user stdout/stderr containing denial text.
  Blocking status: blocking candidate.

Non-blocking notes:
- GitHub CI for head `215d635` is successful, but CI skips real seatbelt-dependent runtime tests on Ubuntu.
- This reviewer did not rerun tests locally.

Execution Summary: agents=review-test-evidence; skills=review; tools=git, gh, rg, sed, nl; verification=read-only review plus orchestrator-provided local verification and GitHub CI status/log inspection; limits=no edits/commits/push, no nested agents.
