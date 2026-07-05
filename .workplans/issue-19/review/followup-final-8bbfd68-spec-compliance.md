Reviewer agent: review-spec-compliance
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 8bbfd68eb474e9d27386fe13a05fb1b549bb5198

Summary: No candidate spec-compliance findings; the #19 raw-data byte invariant and narrowed telemetry boundary are covered by implementation, tests, OpenSpec, and zero-clean evidence.

Invariant Matrix Coverage:
- Governing invariant: covered - `RawDataSandboxedBashTool` runs bash through `sandbox-exec -f <profile>` and profile denies `file-write*` on protected raw paths while allowing reads; six mutation classes are tested with no raw mutation (`packages/core/src/tools/raw-data-sandbox.ts:180`, `packages/core/src/tools/raw-data-sandbox.ts:561`, `packages/core/src/tools/raw-data-sandbox.test.ts:434`).
- Source-of-truth identity/contract: covered - profile id/version, `RAW_DATA_WRITE_RULE_ID`, remediation payload, `tool.failed`, and audit row fields are explicit in code and aligned with the updated spec/ADR (`packages/core/src/tools/raw-data-sandbox.ts:32`, `packages/core/src/tools/raw-data-sandbox.ts:861`, `packages/backend/src/ws/index.ts:29`, `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:21`).
- Producers: covered - sandbox/profile helper, wrapper, advisory rule, audit helper, and WS builder are present and exported from the SHUD-owned packages, not `zero` (`packages/core/src/tools/raw-data-sandbox.ts:437`, `packages/core/src/tools/raw-data-sandbox.ts:719`, `packages/core/src/tools/raw-data-sandbox.ts:821`, `packages/backend/src/ws/index.ts:45`, `packages/core/src/tools/index.ts:12`).
- Validators/preflight: covered - profile construction rejects relative/public helper roots, advisory is fail-open for uncertainty, process preflight is narrowed, and tests cover profile/advisory/nlink/sandbox execution (`packages/core/src/tools/raw-data-sandbox.ts:397`, `packages/core/src/tools/raw-data-sandbox.ts:741`, `packages/core/src/tools/raw-data-sandbox.ts:1091`, `packages/core/src/tools/raw-data-sandbox.ts:3612`).
- Storage/cache/query: covered - temporary profile files are created under an absolute safe root and cleaned with identity checks; audit rows land under `workspace/tasks/TASK-M1-SPIKE/audit/` with path/symlink/hardlink safeguards (`packages/core/src/tools/raw-data-sandbox.ts:283`, `packages/core/src/tools/raw-data-sandbox.ts:4184`, `packages/core/src/tools/raw-data-sandbox.ts:4402`).
- Public routes/entrypoints: covered - no full backend WS route was added; only the M1 skeleton `tool.failed` builder exists, matching the stated scope (`packages/backend/src/ws/index.ts:45`, `openspec/changes/m1-foundation/design.md:173`).
- Frontend/downstream consumers: covered - no frontend consumer is introduced; M1 asserts envelope/payload shape only (`packages/backend/src/ws/index.test.ts:18`, `openspec/changes/m1-foundation/design.md:174`).
- Failure paths/rollback/stale state: covered - post-exec failures remain generic lifecycle evidence, raw-denial telemetry is restricted to trusted advisory evidence, and audit/profile path failures fail closed before side effects (`packages/core/src/tools/raw-data-sandbox.ts:524`, `packages/core/src/tools/raw-data-sandbox.ts:584`, `packages/core/src/tools/raw-data-sandbox.ts:848`, `packages/backend/src/ws/index.ts:76`).
- Evidence/audit/readiness: covered - trusted denial evidence is bound to tool result via private proof plus WeakMap, audit rows match payload identity, hardlink residual is demonstrated, and zero is unchanged (`packages/core/src/tools/raw-data-sandbox.ts:61`, `packages/core/src/tools/raw-data-sandbox.ts:936`, `packages/core/src/tools/raw-data-sandbox.test.ts:3374`).
- Regression row, six escape classes: covered - interpreter payload, pipeline/stdin, dynamic target, child/grandchild shell state, symlink/`../`, and rename/unlink are byte-blocked with generic lifecycle evidence when advisory is disabled (`packages/core/src/tools/raw-data-sandbox.test.ts:434`, `packages/core/src/tools/raw-data-sandbox.test.ts:485`).
- Regression row, raw read and workspace write: covered - raw source reads/copies and workspace writes succeed under the same profile; legal waited foreground child process is allowed (`packages/core/src/tools/raw-data-sandbox.test.ts:2551`, `packages/core/src/tools/raw-data-sandbox.test.ts:2382`).
- Regression row, hardlink residual: covered - pre-existing hardlink alias mutation is honestly demonstrated, and bounded `nlink>1` scan flags only protected-root metadata (`packages/core/src/tools/raw-data-sandbox.test.ts:3374`, `packages/core/src/tools/raw-data-sandbox.ts:1091`).
- Regression row, advisory behavior: covered - obvious same-root raw writes may be denied with remediation/audit/WS evidence; uncertainty and legal reads remain fail-open/generic (`packages/core/src/tools/raw-data-sandbox.test.ts:2579`, `packages/backend/src/ws/index.test.ts:18`).
- Regression row, Zero source cleanliness: covered - verified `git -C zero diff --quiet` exit 0 and zero HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- None.

Non-blocking notes:
- None.

Verification: `pnpm --package=bun@1.2.19 dlx bun run check` passed; `openspec validate m1-foundation --strict --no-interactive` passed; scoped `git diff --check` passed; zero diff/head check passed.

Execution Summary: agents=review-spec-compliance; skills=review; tools=git,rg,sed,openspec,pnpm-bun-check; verification=passed; limits=read-only,no-edits.
