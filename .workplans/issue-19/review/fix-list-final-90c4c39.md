# Fix List for PR #48 - final follow-up 90c4c39

Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`
Verdict table: `.workplans/issue-19/review/verdict-table-final-90c4c39.md`
Gate strategy: `.workplans/issue-19/review/gate-level-pr-strategy-pr48-final-90c4c39.md`

Pattern escalation: yes
Failure classes:
- `state-identity`
- `information-disclosure`
- `process-lifecycle`
- `state-transition`

Invariant:
- The SHUD bash wrapper must bind raw/evidence/config identity at construction/factory time, inherit only finite intentional environment variables, reject statically detectable fake-wait process escapes, and finalize every wrapper-owned terminal path.

## Fix 1: Snapshot sandbox root arrays (P1)

Required behavior:
- Snapshot `protectedRawPaths`, `allowedWriteRoots`, and `protectedEvidencePaths` at `RawDataSandboxedBashTool` construction.
- Snapshot the same root arrays at `createShudSandboxedBashTool()` / runtime registry boundary as needed.
- Caller mutation after construction must not change the protected raw/evidence root or allowed root set used at execution.

Tests:
- Direct `RawDataSandboxedBashTool` test mutates original root arrays after construction; original `data/raw` write remains denied and bytes unchanged.
- Registry/factory test mutates original root arrays after `createShudSandboxedBashTool()`; original raw root remains protected and profile/audit identity remains stable.
- Cover `protectedEvidencePaths` mutation or an equivalent audit/profile safety assertion.

## Fix 2: Replace wildcard locale env inheritance (P1)

Required behavior:
- Remove broad `LC_*` wildcard inheritance from `buildSanitizedToolProcessEnv()`.
- Keep only explicit finite locale names if needed; do not accept arbitrary `LC_` prefixes.
- Explicit `envSecrets` and `stdinSecretRef` must remain the only secret-bearing env/stdin path and must remain redacted.

Tests:
- Set fake `LC_API_KEY` / `LC_PASSWORD` in parent `process.env`; sandboxed command output/env must not include their names or sentinel values.
- Preserve existing ambient secret, host identity, and explicit `envSecrets` tests.
- If an exact locale variable such as `LC_ALL` or `LC_CTYPE` is retained, add or preserve a positive proof for that exact name only.

## Fix 3: Reject fake/unreachable Python Popen waits (P1)

Required behavior:
- Preserve immediate chained wait/communicate and current straight-line `p=Popen(...); sys.exit(p.wait())` foreground child allowance.
- Reject assigned `Popen` forms where a later wait/communicate is unreachable or merely lexical, including `sys.exit(0); p.wait()` and multiline `if False:\n p.wait()`.
- Keep dynamic/over-budget scope aligned with the current issue boundary: do not claim full Python control-flow analysis; be conservatively safe for statically evident fake waits.

Tests:
- `pythonSeatbeltTest` for `sys.exit(0); p.wait()` delayed workspace writer -> `policy_gate_process_containment_unavailable`, no immediate or delayed file, audit failed decision.
- `pythonSeatbeltTest` for multiline `if False:\n p.wait()` delayed writer -> same failure/no file.
- Existing waited foreground child positive test remains green.

## Fix 4: Finalize pre-execute fuse denial (P2)

Required behavior:
- A fuse-denied `RawDataSandboxedBashTool.run()` with a registered running handle must finish the handle with failure metadata.
- Do not weaken Zero fuse behavior or fuse rule object snapshots.
- Keep output summary and user-visible output equivalent to existing fuse denial behavior.

Tests:
- `TestRunningToolRegistry` regression for a fuse-denied command: result is failed, output contains fuse denial, and handle terminal metadata includes `{cause:"completed", success:false, outputSummary: result.outputSummary}`.
- Existing fuse rule snapshot tests remain green.

## Verification after fixes

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`
