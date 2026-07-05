# Final Follow-up Review 1293927 - Test / Evidence

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict: NOT CLEAN

## Blocking Findings

- `cand-final-1293927-01-ci-skips-seatbelt-authority` (P1): the required GitHub status context `check` runs on `ubuntu-latest`, while seatbelt authority tests skip unless running on Darwin with `/usr/bin/sandbox-exec`. The PR check can therefore pass without executing #19 acceptance evidence for execution-layer seatbelt authority.

## Evidence

- `.github/workflows/ci.yml`: `check` job runs on Ubuntu and executes `bun run check`.
- `packages/core/src/tools/raw-data-sandbox.test.ts`: seatbelt tests use `test.skip` when `process.platform !== "darwin"` or `/usr/bin/sandbox-exec` is missing.
- `packages/core/src/tools/policy-gate-registry.test.ts`: registry seatbelt tests follow the same skip condition.
- GitHub run `28747978570`: `68 pass`, `133 skip`, `0 fail` for policy-gate tests, including skips for six byte-deny cases, raw read allow, waited/fake Python Popen cases, constructor/factory snapshots, hardlink scan, and audit rows.

## Verification Read

Reviewer inspected workflow, skip guards, PR checks/logs, issue #19, and OpenSpec acceptance scenarios. Local macOS focused and full checks passed, but the only required CI context did not exercise the core seatbelt evidence.
