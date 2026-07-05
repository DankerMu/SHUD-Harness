# Issue #19 Gate-Level PR Strategy Review

Head SHA: `4074cf423796f35dce3b38f906d707de2a7161f3`

Gate trigger:
- Final comprehensive cross-review on the pushed head produced six deduplicated finding groups.
- Independent verifier agents confirmed all six groups as merge-blocking.
- The repeated invariant family is broader than a missed command list: pure static command text scanning cannot close runtime aliasing, dynamic shell construction, stdin/pipeline execution, and read-only compatibility at the same time.

Current PR state:
- PR #46 has useful implementation and regression evidence for issue #19.
- PR #46 must not be merged in its current form, even though GitHub reports the branch as mechanically mergeable.
- Phase 7 and Phase 8 merge gates are blocked because the latest comprehensive review is not clean.

Root-cause conclusion:
- The #19 invariant says writes under `data/raw/**` must be denied before tool execution.
- The OpenSpec/non-goal boundary also avoids implementing a full shell interpreter.
- Those constraints conflict for arbitrary bash: a pre-exec string scanner cannot soundly prove all writes while also allowing legitimate raw reads and governed-workspace writes.

Selected stronger action:
- Stop ordinary patching on PR #46.
- Re-enter strategy design before continuing #19 or later M1 issues that depend on the policy gate.
- Trigger an ADR-0001 / OpenSpec revisit for the policy gate enforcement boundary.

Root-cause options to evaluate:
- Execution-layer enforcement: make the preflight rule a UX/audit early-deny layer, and add a controlled execution boundary that checks canonical realpath/inode writes or uses an OS-level sandbox/read-only mount for `data/raw/**`.
- Scope revision: narrow #19 to explicit static shell write denial and open a separate execution-sandbox issue for arbitrary writes. This requires spec/ADR change because it weakens the current issue invariant.
- Fail-closed static scanner: deny unknown/dynamic/executable/pipeline forms whenever `data/raw` may be involved. This is not acceptable under the current #19 evidence because it breaks confirmed read-only workflows.

Merge gate:
- Do not merge PR #46 at this SHA.
- Do not continue to Phase 7 final review until the strategy is changed and a new clean comprehensive review passes on the resulting head.
- Treat the existing code as spike evidence, not as the final M1 authority implementation.
