# Phase 5 Fix List: Final Follow-up 3aa3c6d

PR: #48
Issue: #19
Head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750

Pattern escalation: yes
Failure classes:
- evidence/audit root binding
- path/evidence authority drift
- trusted telemetry / evidence-boundary bypass
- test/evidence coverage gap
- flaky verification / fake integration mismatch

Invariant: runtime and public evidence surfaces must bind raw/evidence/workspace identity to explicit stable roots, and raw-denial telemetry must only be minted by trusted sandbox-owned advisory/static evidence paths.

## Fix 1: stable audit/helper root binding

Severity: P1
Verified candidates: cand-3aa3-01, cand-3aa3-02

Required behavior:
- Omitted runtime `auditWorkspaceRoot` must no longer fall back to per-call `ctx.workDir` when a stable `pathResolutionRoot` exists. Bind it to the canonical project workspace root or fail closed.
- Public lower-level helpers must not silently resolve relative roots against `process.cwd()`. Reject relative roots or add explicit stable-base resolution with fail-closed missing-base behavior.

Required tests:
- Runtime omitted audit root + stable `pathResolutionRoot` + nested `ctx.workDir` writes audit under canonical project workspace, or fails closed by design.
- Public helper cwd-drift tests for audit append, profile builder, and hardlink scan.
- Absolute-root helper inputs remain compatible.

## Fix 2: trusted telemetry boundary

Severity: P1
Verified candidate: cand-3aa3-03

Required behavior:
- Public audit append rejects `raw-data-write` rows with raw-denial decisions (`denied_by_advisory` and `denied_by_sandbox`).
- Trusted internal advisory path still appends raw-denial rows via reserved reservation/converter.
- Generic WS builder cannot mint raw-denial-shaped events. Raw advisory `tool.failed` emission must go through a trusted converter/builder; `denied_by_sandbox` remains disabled until a real OS event source exists.

Required tests:
- Public append rejects raw denied-by-advisory and denied-by-sandbox.
- Generic lifecycle `allowed|failed` rows still append.
- WS generic builder rejects raw denial shapes; trusted raw advisory builder/converter still builds remediation-bearing `tool.failed`.

## Fix 3: relative protected evidence regression

Severity: P2
Verified candidate: cand-3aa3-04

Required behavior/test:
- Add macOS seatbelt regression with relative `protectedEvidencePaths`, relative `allowedWriteRoots`, explicit `pathResolutionRoot`, changed process cwd, and nested `ctx.workDir`; protected evidence write is denied and normal workspace write remains allowed.

## Fix 4: abort fake fidelity

Severity: P2
Verified candidate: cand-3aa3-05 (PLAUSIBLE)

Required behavior:
- Test fake `TestRunningToolHandle.setAbortHandler()` replays pending aborts like Zero's real handle, or tests synchronize on handler registration.

Required tests:
- Focused proof that request-abort-before-handler gets delivered.
- Repeat or focused abort-containment tests remain stable.

## Verification

Required after implementation:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check origin/main...HEAD`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`

