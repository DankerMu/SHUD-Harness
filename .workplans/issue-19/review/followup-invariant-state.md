Reviewer agent: followup-invariant-state
Review round: follow-up round 2 after fixes
Reviewed head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Verdict: BLOCKED

Summary:
- Guard class, `tool.failed`, `seq`/`event_id`, and tool/ws/audit evidence linkage are consistent.
- The raw path confinement invariant remains under-approximated and can still allow real writes to `data/raw/**`.
- Targeted tests passed during review: 46 policy-gate tests, OpenSpec validation, and zero submodule cleanliness.

Findings:
- cand-inv-01 / P1 / merge-blocking:
  - Failure class: authority guard / path-confinement under-approximation.
  - Contract: bash writes to `data/raw/**` must be denied before inner tool execution and leave synchronized evidence.
  - Scenarios: `sed --in-place s/a/b/ data/raw/input.csv`, `find data/raw -delete`, `rsync /tmp/x data/raw/x`, `touch data/{raw,processed}/x`.
  - Evidence:
    - `packages/core/src/tools/data-raw-write-rule.ts:12` enumerates a small mutation command set.
    - `packages/core/src/tools/data-raw-write-rule.ts:155` allows unmatched command forms.
    - `packages/core/src/tools/data-raw-write-rule.ts:179` recognizes `sed -i` but not `--in-place`.
    - `packages/core/src/tools/data-raw-write-rule.test.ts:27` lacks denied regressions for these boundaries.
  - Consequence: raw data read-only status is not an invariant; denials and WS/audit evidence are skipped because the decision is allow.
  - Required proof: add denied regressions for the scenarios above and assert `bashTool.calls === 0`, rule/guard/remediation consistency.

- cand-inv-02 / P2 / follow-up:
  - Failure class: path identity over-approximation / state classifier drift.
  - Contract: protected identity should be canonical project `data/raw/**`, not every directory named `data/raw`.
  - Scenario: `printf x > scratch/data/raw/out.csv` is classified as protected raw even if it is not the repo-root protected raw tree.
  - Evidence:
    - `packages/core/src/tools/data-raw-write-rule.ts:343` matches any normalized path ending in or containing `/data/raw`.
    - `packages/core/src/tools/data-raw-write-rule.test.ts:150` lacks non-protected same-name directory compatibility coverage.
  - Consequence: legitimate scratch/workspace output can be denied as an authority violation.
  - Required proof: add an allowed regression for a non-protected same-name directory and a denied regression for canonical protected raw.

Non-blocking notes:
- No drift found for `guard_class=authority` from rule to decision to tool payload to WS payload to audit row.
- `tool.failed` is reused; no new WS event type was introduced.
- `taskId`/`fileName` traversal checks exist for audit helper.
