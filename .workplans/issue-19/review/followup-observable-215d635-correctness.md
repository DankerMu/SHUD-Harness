# Review report -- PR #48 observable 215d635 correctness

Reviewer agent: review-correctness
Review round: follow-up observable 215d635
Reviewed head SHA: 215d635e8edc6c4e5db3af8b833cf377fdda02cc

Summary:
One blocking correctness gap remains: observable denial attribution can still promote hidden or unrelated permission output into `raw_data_write_denied`.

Invariant Matrix Coverage:
- Raw byte authority: covered - seatbelt profile still denies protected raw writes and zero submodule remains clean/pinned.
- Advisory fail-open boundary: covered - legal raw reads and over-budget benign commands are not pre-denied by the reviewed diff.
- Observable denial attribution: missing - attribution still accepts basename/path text from unrelated output, so hidden denials can be falsely claimed as observable raw sandbox denials.
- Symlinked raw-dir mutation coverage: covered - added target extraction for `mv`, `mkdir`, `rm`/`unlink`, and `ln`, with symlink-leaf removal negative coverage.
- Outer raw deny provenance: covered - mismatched outer raw roots now return generic `policy_gate_denied` without unrelated profile identity.
- WS/audit shape coherence: covered for the paths reviewed - payload/audit/WS helpers preserve rule, decision, guard class, profile id, and invocation id when denial evidence is valid.
- Zero unchanged: covered - `git -C zero diff --quiet` returned 0 and `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- Severity: P1
  Failure class: evidence/audit false positive / observable-denial attribution.
  Violated invariant/contract: Hidden or suppressed raw-write denials are out of telemetry scope and must not be claimed as `raw_data_write_denied`; audit rows must record only observable facts attributable to the protected raw mutation.
  Concrete scenario: A command suppresses the real raw-write denial, then emits or triggers an unrelated visible permission error that shares the same target leaf name, for example `printf hidden 2>/dev/null > data/raw/input.csv || true; cat workspace/input.csv` where `workspace/input.csv` is unreadable. The raw write is byte-blocked but hidden; the visible `Permission denied` belongs to the workspace read. `lineMentionsTarget()` still returns true because it accepts `basename(resolvedPath)` (`input.csv`) as sufficient target evidence, so `isLikelySandboxDenialForCommand()` upgrades the result to `raw_data_write_denied`.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3588`, `packages/core/src/tools/raw-data-sandbox.ts:3593`, `packages/core/src/tools/raw-data-sandbox.ts:3676`, `packages/core/src/tools/raw-data-sandbox.ts:3693`.
  Consequence: ToolResult, audit, and future WS consumers can receive a false `denied_by_sandbox` record for a hidden or unrelated denial, reintroducing the evidence/audit false-positive class.
  Fix direction: Tighten attribution so a denial line must mention the concrete path form used by the failed raw mutation or a canonical protected raw path, not just a basename or ambiguous leaf token.
  Required verification: Add a regression where raw write denial is hidden and the only visible `Permission denied` references a workspace path with the same basename as the raw target; assert generic failed/allowed result, no `raw_data_write_denied`, and no `denied_by_sandbox` audit row. Also add a dead-branch/user-printed exact target-path denial regression if exact printed paths remain accepted.
  Sibling surfaces: `lineMentionsTarget()` variants for bare relative targets after `cd data/raw`, `lineMentionsProtectedRawSignal()` fallback, and tests around suppressed denials.
  Blocking status: blocking.

Non-blocking notes:
- Typecheck/tests were not executed by this reviewer because `bun` was not installed in the review environment.

Execution Summary: agents=review-correctness; skills=review; tools=sed, rg, git diff, git diff --check, git rev-parse, git status, git -C zero; verification=static diff review plus zero cleanliness/pin check; limits=no file edits, no commits, no test execution due missing bun.
