# Fix list -- PR #48 observable 067e544

Head SHA: `067e544368f88ec60922a243f1bcf6597f211489`

Input verdict table: `.workplans/issue-19/review/verdict-table-observable-067e544.md`

## Class A -- observable sandbox denial attribution

Verified findings:
- cand-observable-067-01: symlinked mutation commands can lose visible denial evidence.
- cand-observable-067-02: denial-like user output can become false raw sandbox denial.
- cand-observable-067-03: over-budget visible raw write denial can be downgraded to generic failure.

Severity:
- P1, merge-blocking.

Violated invariant:
- Emit `raw_data_write_denied` / `decision=denied_by_sandbox` only for visible process results attributable to an attempted raw mutation protected by the sandbox; preserve true visible denials across symlink aliases and bounded analysis fallback; never promote hidden/suppressed or user-forged denial text.

Requested behavior:
- A real visible sandbox denial through canonical raw paths, symlinked raw directories, command exit normalization (`|| true` / `; true`), or over-budget command text must return remediation-shaped `raw_data_write_denied`, audit `decision=denied_by_sandbox`, and backend-compatible `tool.failed` input.
- A command that only prints `Permission denied` / `sandbox`, or has a raw target in a dead branch, or suppresses the actual raw-denial stderr while printing unrelated denial text, must not be upgraded to `denied_by_sandbox`.
- The classifier may be conservative for un-attributable output: keep generic `failed` or `allowed` according to the underlying process result rather than fabricating raw-denial telemetry.

Required tests/proof:
- Symlinked raw directory mutations: `mv`, `mkdir`, `rm` or `unlink`, and `ln` destination forms produce `raw_data_write_denied` when the OS visibly denies the raw mutation; raw bytes remain unchanged.
- Negative symlink case: removing a workspace symlink leaf that merely points to raw does not become raw-denial evidence.
- Dead-branch raw target plus user-printed `Permission denied` does not become `raw_data_write_denied`.
- Suppressed raw-denial stderr plus unrelated visible denial text does not become `raw_data_write_denied`.
- Actual visible exit-normalized raw denial still becomes `raw_data_write_denied`.
- Over-budget visible raw write denial still becomes `raw_data_write_denied`; over-budget raw read/unrelated permission text remains generic.

## Class B -- advisory deny profile/evidence identity

Verified findings:
- cand-observable-067-04: outer raw policy denial can emit unrelated sandbox profile identity.

Severity:
- P2 by reviewer, treated as merge-blocking in this high-risk evidence pass because it touches audit/provenance identity.

Violated invariant:
- ToolResult, audit row, and WS evidence for raw advisory/sandbox denials must carry coherent rule/profile identity. `profile_id` must not imply the denial was governed by a sandbox profile over a different protected root set.

Requested behavior:
- Either reject/avoid mismatched outer raw advisory roots for `RawDataSandboxedBashTool`, or build advisory-deny evidence from the same protected root set that caused the outer raw deny.
- Do not execute bash on outer raw deny.
- Payload, audit row, and WS event must agree on the final identity.

Required tests/proof:
- Mismatched outer raw advisory root regression that proves no unrelated `profile_id` is emitted, or that registry construction/evaluation rejects the mismatch before a misleading evidence row can be produced.
- Existing matching-root outer deny still returns `denied_by_advisory` without executing bash and with coherent payload/audit identity.

Verification floor after fix:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
