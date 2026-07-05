# Review report -- PR #48 observable 067e544 correctness

Reviewer agent: review-correctness
Review round: follow-up observable 067e544
Reviewed head SHA: 067e544368f88ec60922a243f1bcf6597f211489

Summary:
The direct 37-01..37-08 reproductions are closed, but two adjacent correctness candidates remain in observable-denial classification. Both affect evidence/audit truthfulness, not raw byte authority.

Invariant Matrix Coverage:
- Raw bytes under `data/raw/**`: covered for the reviewed six escape classes; no direct byte-authority regression found.
- Observable denial telemetry: mostly covered, but symlink-aware post-exec classification is incomplete for delete/rename/interpreter-style targets.
- Hidden/no-output/suppressed denial telemetry: mostly covered, but within-budget unrelated denial-like output can still be promoted to `denied_by_sandbox`.
- Legal raw read/workspace write/waited foreground child: covered by current tests and no regression found.
- Hardlink residual: bounded protected-root scan present; no broader traversal found.
- Static advisory: fail-open on uncertainty and legal-read overdeny protections are present.
- Zero unchanged: verified clean at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:

1. Severity: P1
   Failure class: observable-denial evidence / symlink alias target coverage gap.
   Violated invariant/contract: Observable OS denials for raw escape classes, including symlink aliases and rename/unlink, must produce remediation-shaped tool failure plus `tool.failed`/audit denial evidence when the denial is visible.
   Concrete scenario: `workspace/raw-link -> ../data/raw`, `data/raw/input.csv` exists, then `rm workspace/raw-link/input.csv` or `mv workspace/raw-link/input.csv workspace/out.csv`. Seatbelt should visibly deny the raw unlink/rename and preserve bytes, but post-exec symlink classification has no candidate path for these command forms, so the result can fall through as generic `failed`.
   Evidence: `isLikelySandboxDenialForCommand()` only falls back to symlink resolution around `packages/core/src/tools/raw-data-sandbox.ts:3581`. The symlink candidate collector covers redirection, `cp`/`install`, `dd`, and selected operand-write commands, but omits `rm`, `unlink`, and `mv` around `packages/core/src/tools/raw-data-sandbox.ts:3684`. Lexical static detection includes `mv`, `rm`, and `unlink` when the token itself resolves to raw around `packages/core/src/tools/raw-data-sandbox.ts:1981`. Current symlink regression covers redirection only around `packages/core/src/tools/raw-data-sandbox.test.ts:162`.
   Consequence: Raw bytes remain protected, but observable raw delete/rename denials through symlink aliases lose remediation/audit denial evidence.
   Fix direction: Reuse or extend one bounded mutating-target collector for post-exec symlink resolution so it covers the same write/delete/rename surfaces as static raw detection, including `rm`/`unlink`, relevant `mv` endpoints, `mkdir`/`ln` raw-directory writes, and interpreter literal path APIs where feasible.
   Required test/proof: Add seatbelt tests for symlink-directory `rm`, `mv`, and one interpreter literal write through `workspace/raw-link/...`, asserting `raw_data_write_denied`, `decision=denied_by_sandbox`, remediation, matching audit identity, and unchanged raw bytes.
   Sibling surfaces: `rm`, `unlink`, `mv`, `mkdir`, `ln`, interpreter file APIs, child shell payloads, symlinked raw directories.
   Blocking status: Blocking candidate.

2. Severity: P1
   Failure class: evidence/audit false positive / hidden denial misclassified from unrelated text.
   Violated invariant/contract: Hidden or suppressed OS denials are out of #19 telemetry scope and must not be presented as detected; audit rows must record observable facts only.
   Concrete scenario: `printf 'Permission denied\n' >&2; d=data; r=raw; p="$d/$r/hidden.txt"; printf hidden > "$p" 2>/dev/null || true`. The raw write denial is suppressed and exit-normalized; the visible `Permission denied` text is unrelated. Current classification still has a known dynamic raw target and denial-like output, so it can emit `raw_data_write_denied` with `decision=denied_by_sandbox`.
   Evidence: The denial pattern is broad around `packages/core/src/tools/raw-data-sandbox.ts:42`. Post-exec classification returns true when denial-like output exists and command analysis has a known raw write target around `packages/core/src/tools/raw-data-sandbox.ts:3570`. `hasKnownRawDataWriteTarget()` treats static, parent-relative, or dynamic raw target signals as sufficient around `packages/core/src/tools/raw-data-sandbox.ts:3584`. Tests cover raw reads with denial-like text and over-budget unrelated permission text, but not within-budget suppressed raw writes plus unrelated denial-like output.
   Consequence: The tool result and audit can falsely claim an OS sandbox denial was observed, regressing the hidden-telemetry-out-of-scope boundary.
   Fix direction: Tie success-normalized sandbox-denial classification to target-specific shell/interpreter error text or another bounded proof that the visible denial came from the raw write target.
   Required test/proof: Add a within-budget regression where an unrelated denial-like line is printed and the raw denial is suppressed/exit-normalized; assert no `raw_data_write_denied`, generic allowed/failed audit per exit state, and unchanged raw bytes. Retain visible `|| true` cases where the captured error names the raw target.
   Sibling surfaces: dynamic shell variables, static raw redirections with stderr redirected away, interpreter `try/catch` or stderr suppression, user output containing `sandbox` or `Permission denied`.
   Blocking status: Blocking candidate.

Non-blocking notes:
None.

Execution Summary: agents=review-correctness; skills=review; tools=gh, git, rg, sed, nl; verification=read-only PR diff/context review and zero status check; limits=no edits/commits/push, no nested agents.
