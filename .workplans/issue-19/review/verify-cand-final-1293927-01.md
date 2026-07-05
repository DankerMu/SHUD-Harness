# Verifier Report - cand-final-1293927-01-ci-skips-seatbelt-authority

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict: CONFIRMED

## Evidence

- Required status checks contain only `check`.
- PR #48 checks showed only `check pass`.
- `.github/workflows/ci.yml` runs the `check` job on `ubuntu-latest` and executes `bun run check`.
- `raw-data-sandbox.test.ts` and `policy-gate-registry.test.ts` skip seatbelt tests unless Darwin with `/usr/bin/sandbox-exec`.
- GitHub run `28747978570` showed Ubuntu 24.04 and policy-gate result `68 pass`, `133 skip`, `0 fail`.
- The skipped tests include the #19 core acceptance evidence for raw byte-deny, read/write allow, waited/fake Python Popen, env secrecy, snapshots, hardlink scan, and audit rows.

## Merge Impact

Blocks merge. Required CI can be green while the execution-layer seatbelt authority evidence is not executed.

## Minimal Fix

Add a required macOS seatbelt authority check that fails if `/usr/bin/sandbox-exec` is unavailable and runs at least the policy-gate seatbelt suite. Preserve the required `check` context by making it aggregate the Linux and macOS jobs.
