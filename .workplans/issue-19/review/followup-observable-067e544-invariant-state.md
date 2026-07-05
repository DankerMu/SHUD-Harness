# Review report -- PR #48 observable 067e544 invariant-state

Reviewer agent: review-invariant-state
Review round: follow-up observable 067e544
Reviewed head SHA: 067e544368f88ec60922a243f1bcf6597f211489

Summary:
Not clean. The direct fixes close the prior visible exit-normalized denial path and the unbounded process-preflight scan, and 37-02..37-08 look closed under the current #19 observable boundary. One 37-01 sibling gap remains: symlink-aware observable-denial classification only covers some write forms, not the full raw mutation surface.

Invariant Matrix Coverage:
- Raw-byte authority: covered for canonical raw paths by seatbelt profile and runtime tests.
- Evidence identity: covered for classified denials; payload, audit row, and WS builder preserve rule/profile/error/invocation identity.
- Visible denial state: partially covered; `|| true` / `; true` known-target denials now fail correctly, but symlinked-directory mutation commands can still fall to generic failure.
- Hidden/no-output denial: covered as out of telemetry scope; tests keep these from claiming `raw_data_write_denied`.
- Process preflight/resources: prior unbounded scan closed with a bounded preflight slice, coarser `ps` polling, output truncation, timeout/abort/waited-child regressions.
- Previous 37-01..37-08: 37-02..37-08 closed; 37-01 partially closed with sibling regression below.

Findings:

1. Severity: P1
   Failure class: observable-denial evidence / symlink alias classification.
   Violated invariant/contract: Observable raw write/delete/rename denials through symlink or path aliases must produce remediation-shaped `raw_data_write_denied`, `tool.failed`, and audit denial evidence, not a generic command failure.
   Concrete scenario: `workspace/raw-dir -> ../data/raw`; run `printf x > workspace/source.txt; mv workspace/source.txt workspace/raw-dir/moved.txt` with advisory disabled. Seatbelt denies the raw destination visibly, raw bytes stay protected, but the classifier does not collect `mv` destinations for symlink resolution, so the result falls through as generic `decision=failed`. Similar gaps apply to `mkdir workspace/raw-dir/new`, `rm workspace/raw-dir/input.csv`, `unlink`, and `ln` destination forms.
   Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3577` only upgrades when analysis has a known raw target; `packages/core/src/tools/raw-data-sandbox.ts:3581` delegates symlink-only cases to literal candidate resolution; that resolver includes `cp/install` around `packages/core/src/tools/raw-data-sandbox.ts:3684` and a limited command set around `packages/core/src/tools/raw-data-sandbox.ts:3699`, but omits `mv`, `mkdir`, `rm`, `unlink`, and `ln` even though lexical detection treats these as raw mutations around `packages/core/src/tools/raw-data-sandbox.ts:1981` and `packages/core/src/tools/raw-data-sandbox.ts:1994`.
   Consequence: Downstream evidence can lose rule/remediation/profile identity for visible raw denials on supported symlink/path-alias escape classes.
   Fix direction: Extend bounded symlink candidate extraction to every mutation command class handled by lexical raw detection, with command-specific care for symlink leaf operations that do not mutate the raw target.
   Required test/proof: Add seatbelt regressions for symlinked-directory `mv`, `mkdir`, `rm/unlink`, and `ln` raw-target denials asserting `denied_by_sandbox`, audit identity, and no raw mutation; retain a negative case for removing a workspace symlink leaf that does not touch raw bytes.
   Sibling surfaces: child shell forms, cwd changes into symlinked workspace dirs, absolute symlink paths under allowed roots, advisory-disabled execution, audit and WS evidence builders.
   Blocking status: yes, candidate P1.

2. Severity: P2
   Failure class: false denial evidence / output-only classification.
   Violated invariant/contract: `raw_data_write_denied` should be emitted only when denial-like process output is tied to an actual observable sandbox/advisory denial, not merely user-controlled output plus a syntactic raw target somewhere in the command text.
   Concrete scenario: With advisory disabled, `if false; then printf nope > data/raw/not-run.txt; fi; printf "Permission denied\n"` exits successfully without attempting the raw write, but post-exec classification can see denial-like output plus a lexical raw target and return `denied_by_sandbox`.
   Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3570` inspects merged `result.output`; `packages/core/src/tools/raw-data-sandbox.ts:3577` no longer requires a failed result before upgrading to denial; shell analysis around `packages/core/src/tools/raw-data-sandbox.ts:1856` / `packages/core/src/tools/raw-data-sandbox.ts:2880` is syntactic and does not model control flow.
   Consequence: Audit and tool result can falsely claim an OS sandbox denial, polluting evidence and blocking otherwise successful commands in advisory-disabled or future fail-open paths.
   Fix direction: Preserve the exit-normalized real-denial fix, but tie post-exec denial matching to stderr/channel-aware sandbox output or another stronger runtime signal; keep arbitrary stdout text from triggering denial solely because a raw target appears in an unexecuted segment.
   Required test/proof: Add a dead-branch raw target plus denial-like stdout regression that remains allowed/generic, and retain `2>&1 || true` / visible stderr raw-denial regressions as `denied_by_sandbox`.
   Sibling surfaces: `if`/`case`/short-circuit shell forms, child-shell strings, interpreter snippets, merged stdout/stderr output, over-budget classification.
   Blocking status: no, candidate P2.

Non-blocking notes:
None.

Execution Summary: agents=review-invariant-state; skills=review; tools=git, gh, rg, sed, nl; verification=read-only diff/code/test review, no tests run; limits=no edits/commits/push, no nested agents.
