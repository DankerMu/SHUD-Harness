# Fix list -- PR #48 observable 215d635

Head SHA: `215d635e8edc6c4e5db3af8b833cf377fdda02cc`

Input verdict table: `.workplans/issue-19/review/verdict-table-observable-215d635.md`

## Class A -- observable-denial false attribution

Verified finding:
- cand-observable-215-01: target-qualified forged or unrelated denial text can become false raw sandbox denial.

Severity:
- P1, merge-blocking.

Violated invariant:
- `raw_data_write_denied` / `decision=denied_by_sandbox` must only describe observable raw mutation denial evidence. Hidden/suppressed denials and user-controlled or unrelated denial text must not be presented as OS sandbox denial.

Requested behavior:
- Remove or strictly narrow weak output attribution paths, especially basename-only matching and path text that can be printed by the command itself.
- Commands with dead-branch raw targets plus `Permission denied` text naming the target must remain generic.
- Commands with hidden raw denial plus unrelated same-basename permission errors must remain generic.
- Over-budget forged target denial text must remain generic.
- Existing true visible raw-denial positives may remain only where the implementation can justify attribution without relying on user-forgeable target text; otherwise prefer generic result under M1.

Required verification:
- Add regressions for:
  - dead-branch target-forged denial text (`data/raw/<target>: Permission denied` and `<target>: Permission denied`);
  - hidden raw denial plus unrelated workspace permission error sharing the target basename;
  - over-budget target-forged denial text.
- Assert no `raw_data_write_denied`, no `decision=denied_by_sandbox` audit row, unchanged raw bytes, and generic result according to underlying exit status.
- Retain positive regressions for canonical visible raw denials, symlinked raw-dir mutation denials, and over-budget true visible raw-denial cases only if the classifier still supports them honestly.

## Class B -- outer raw deny sibling-root identity collapse

Verified finding:
- cand-observable-215-02: outer raw deny can still collapse sibling root identity when inner raw text is present.

Severity:
- P1, merge-blocking.

Violated invariant:
- Raw-denial evidence profile/root identity must correspond to the protected root that caused the raw-rule denial. A generic/custom outer `RAW_DATA_WRITE_RULE_ID` deny without matched-root identity must not be upgraded by re-parsing command text against inner sandbox roots.

Requested behavior:
- Do not route custom outer `RAW_DATA_WRITE_RULE_ID` denies through `denyByOuterRawPolicyGate()` based solely on command re-analysis.
- Return generic `policy_gate_denied` for outer raw denies unless there is trusted same-root identity. Matching-root raw-denial evidence can remain inside `RawDataSandboxedBashTool`'s own advisory/sandbox execution paths.
- Do not execute bash on outer raw deny.

Required verification:
- Add mismatched outer raw root regression with an additional inner `data/raw` dead-branch/static sibling target; assert generic `policy_gate_denied`, no `raw_data_write_denied`, no sandbox `profile_id`, no audit row, and no bash side effect.
- Keep coverage for sandbox tool's own advisory/raw-denial path where appropriate, or update tests if custom outer raw deny is intentionally generic.

Verification floor after fix:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
