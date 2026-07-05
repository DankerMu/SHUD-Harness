# Review report -- PR #48 observable 215d635 security-perf

Reviewer agent: review-security-perf
Review round: follow-up observable 215d635
Reviewed head SHA: 215d635e8edc6c4e5db3af8b833cf377fdda02cc

Summary:
One blocking evidence-security candidate remains; raw byte authority still appears intact, but observable-denial attribution can still promote unrelated permission output to `denied_by_sandbox`.

Invariant Matrix Coverage:
- Path safety: covered - seatbelt profile still protects canonical raw roots; symlinked raw-dir target extraction now covers `mv`, `mkdir`, `rm/unlink`, and `ln` destination forms, with symlink-leaf removal kept negative.
- Process/runtime containment: covered - foreground waited subprocess allowance and bounded process preflight remain consistent with the narrowed acceptance boundary.
- Evidence/audit/WS contract: missing - the audit/WS builders are faithful to the raw-denial payload, but the payload can still be produced from unrelated visible permission text.
- Regression/test evidence: missing - current regressions cover dead-branch and suppressed-unrelated text without target-name collision, but not unrelated permission output that shares the raw target basename.
- Resource/performance bounds: covered - command/output capture, symlink target collection, process preflight, and hardlink scan remain bounded.
- Wrapper/proxy faithfulness: covered - mismatched outer raw roots now return generic `policy_gate_denied` without sandbox profile identity or execution side effects.
- Zero unchanged: covered - `git -C zero diff --quiet` succeeded and Zero HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- Severity: P1
  Failure class: evidence/audit false positive.
  Violated contract/invariant: `raw_data_write_denied` / `decision=denied_by_sandbox` must only be emitted when visible process output is attributable to an observable OS sandbox denial for the protected raw mutation; hidden/suppressed raw denials and unrelated permission failures must not be presented as observed raw-denial telemetry.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3593` accepts any denial line matched by `lineMentionsTarget`, and `packages/core/src/tools/raw-data-sandbox.ts:3693` falls back to matching only `basename(resolvedPath)`. That lets a line such as `grep: workspace/no-read.txt: Permission denied` match a hidden raw target `data/raw/no-read.txt` solely by basename. The matched result is then upgraded to raw denial evidence at `packages/core/src/tools/raw-data-sandbox.ts:411`.
  Concrete scenario: With advisory disabled, create `workspace/no-read.txt` with mode `000`, then run `printf hidden 2>/dev/null > data/raw/no-read.txt || true; grep raw data/raw/input.csv workspace/no-read.txt`. The raw write denial is suppressed, while the visible failure is an unrelated workspace read permission error. Because the unrelated line contains `no-read.txt`, the current basename fallback can return `raw_data_write_denied` and audit `decision=denied_by_sandbox`.
  Consequence: Tool result, audit row, and future `tool.failed` event can falsely claim an observable raw sandbox denial, masking the real command failure and making PI-facing evidence/remediation untrustworthy.
  Fix direction: Remove the basename-only attribution fallback, or restrict it behind stronger proof that the denial line refers to the protected raw path.
  Required verification: Add a macOS seatbelt regression for the same-basename scenario asserting no `raw_data_write_denied`, no `denied_by_sandbox` audit row, and unchanged raw bytes. Keep positive regressions for actual visible raw denials through canonical paths, dynamic targets, symlinked raw directories, and over-budget bounded-prefix cases.
  Sibling surfaces: `lineMentionsProtectedRawSignal`, over-budget attribution in `isLikelySandboxDenialForCommand`, audit and WS consumers that trust `decision=denied_by_sandbox`.
  Blocking status: blocking candidate.

Non-blocking notes:
- `git diff --check origin/main...HEAD` passed.
- This reviewer did not run the Bun test suite.

Execution Summary: agents=review-security-perf; skills=review; tools=git, rg, sed, nl; verification=static diff/source review plus git diff --check and zero diff/HEAD check; limits=no repo edits, commits, pushes, tests, or nested agents.
