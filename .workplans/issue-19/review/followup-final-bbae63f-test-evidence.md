# Follow-up Comprehensive Review — test/evidence

Reviewed head SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Reviewer: Hypatia (`019f327a-742e-7a50-afcf-0462f218d849`)
Verdict: FINDINGS

Finding 1:
- Severity: P2
- Failure class: test evidence / resource runtime bounds
- Files:
  - `packages/core/src/tools/raw-data-sandbox.test.ts`
  - `packages/core/src/tools/raw-data-sandbox.ts`
  - `.workplans/issue-19/review/fix-list-final-a81819e.md`
- Candidate: bounded sampling regression only asserts the exported delay helper. It does not prove the real tracker path stops periodic full-process-table sampling during a normal successful long-running command.

Finding 2:
- Severity: P2
- Failure class: workflow evidence / SHA match
- Files:
  - `.workplans/issue-19/review/verdict-table-final-a81819e.md`
  - `.workplans/issue-19/review/fix-resolution-final-a81819e.md`
- Candidate: current head is `bbae63f2...`, while final evidence files are still anchored to `a81819e...` and state that another comprehensive follow-up / Phase 7 is required.

Other coverage:
- Six negative cases, positive raw read/workspace write/waited child, `tempRoot` ancestor, mutable WS evidence, process preflight, hardlink residual, and OpenSpec/task text are covered.
