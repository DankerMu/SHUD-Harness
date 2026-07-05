# Review report -- PR #48 observable 215d635 spec-compliance

Reviewer agent: review-spec-compliance
Review round: follow-up observable 215d635
Reviewed head SHA: 215d635e8edc6c4e5db3af8b833cf377fdda02cc

Summary:
One P1 candidate remains in observable-denial attribution: target-forged process output can still be promoted to sandbox-denial evidence.

Invariant Matrix Coverage:
- OpenSpec task 3.3 / clause 2': covered with finding - OS seatbelt authority and M1 observable boundary are implemented, but observable-denial attribution still has a false-positive gap.
- Raw byte authority for six escape classes: covered.
- Legal raw read and workspace write: covered.
- Legal waited foreground subprocess: covered.
- Hidden/suppressed denial boundary: missing - hidden/unrelated text is covered, but target-forged denial text remains untested and can still fabricate `denied_by_sandbox`.
- Symlink alias observable attribution: covered.
- Over-budget visible raw-write denial: covered with finding-adjacent caveat - true visible raw denial is preserved, forged target-specific over-budget denial is not covered.
- Outer raw policy root mismatch: covered - mismatched outer root returns generic policy denial without profile identity.
- Audit / WS skeleton shape: covered but affected by finding.
- Hardlink residual and bounded scan: covered.
- Zero unchanged: covered.
- Scope / altitude: covered.

Findings:
- Severity: P1
  Failure class: contract.
  Violated invariant/contract: Observable sandbox-denial telemetry must only be emitted for denial evidence attributable to an actually visible raw-data mutation attempt; hidden/suppressed or user-forged denial text must not produce `raw_data_write_denied`, `decision=denied_by_sandbox`, audit denial rows, or WS denial evidence.
  Concrete scenario: With advisory failing open because the command is over budget, run a command that never executes the raw write but prints a target-specific denial line, for example `if false; then printf nope > data/raw/forged-target.txt; fi; printf 'data/raw/forged-target.txt: Permission denied\n' >&2; false # <140k filler>`. The raw file is not mutated and no OS raw denial occurred, but the current post-exec classifier can treat the forged output as target-attributed sandbox evidence.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3585` slices over-budget commands to a bounded prefix, `packages/core/src/tools/raw-data-sandbox.ts:3588` collects raw mutation targets from that command text, and `packages/core/src/tools/raw-data-sandbox.ts:3593` upgrades when any denial-like line mentions the collected target. `lineMentionsTarget` accepts raw path variants and basename-only matches at `packages/core/src/tools/raw-data-sandbox.ts:3673`.
  Consequence: Tool result, audit row, and WS evidence can falsely state that seatbelt denied a raw write when the only observable fact is user-controlled process output.
  Fix direction: Tighten post-exec denial attribution so target-specific text alone is not enough when execution of the raw mutation is not established; prefer conservative fallback to generic command failure unless the denial line matches a known shell/interpreter OS-denial form from an actually executed mutation surface.
  Required verification: Add regressions for dead-branch target-forged denial and suppressed raw denial with target-forged visible text, including an over-budget variant where advisory fails open. Assert generic `failed`, no `raw_data_write_denied`, no `decision=denied_by_sandbox`, raw bytes unchanged, and no sandbox-denial audit/WS evidence.
  Sibling surfaces: `lineMentionsProtectedRawSignal` raw-path fallback, basename-only target matching, over-budget bounded-command fallback, interpreter stderr formats, symlink alias targets, `|| true` / `; false` normalization paths, and outer raw-policy deny attribution.
  Blocking status: blocking candidate.

Non-blocking notes:
- Could not run targeted tests in reviewer environment because `bun` was unavailable.

Execution Summary: agents=review-spec-compliance; skills=review; tools=sed, rg, find, git diff, git log, git status, git rev-parse, bun test attempt; verification=static diff/OpenSpec/test-evidence review plus zero submodule clean check; limits=targeted tests not executed because bun runtime is unavailable.
