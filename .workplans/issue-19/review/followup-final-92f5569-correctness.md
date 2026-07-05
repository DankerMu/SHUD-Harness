Reviewer agent: review-correctness
Review round: final comprehensive follow-up 92f5569
Reviewed head SHA: 92f556915416a57015dcaa32ca97e044c9fc3353
Summary: No actionable correctness findings; 92f5569 preserves the scoped raw-byte protection invariant and closes the b999d2e follow-ups.

Invariant Matrix Coverage:
- Governing invariant: covered - Seatbelt profile denies writes to canonical protected raw/evidence paths while allowing reads and workspace writes; escape-class tests assert no raw mutation (`packages/core/src/tools/raw-data-sandbox.ts:206`, `packages/core/src/tools/raw-data-sandbox.test.ts:933`).
- Source-of-truth identity/contract: covered - Implementation follows 条 2' trusted-source narrowing and emits remediation-shaped denial payloads with profile identity (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:21`, `packages/core/src/tools/raw-data-sandbox.ts:1129`).
- Producers: covered - SHUD-owned registry replaces bash with `RawDataSandboxedBashTool`, wraps tools, builds advisory/audit/WS evidence without changing Zero (`packages/core/src/tools/policy-gate-registry.ts:111`, `packages/core/src/tools/policy-gate-registry.ts:131`, `packages/backend/src/ws/index.ts:55`).
- Validators/preflight: covered - Tests cover profile behavior, advisory decisions, hardlink scanner, execution sandbox, evaluator exceptions, and WS trusted evidence (`packages/core/src/tools/raw-data-sandbox.test.ts:1986`, `packages/core/src/tools/policy-gate-registry.test.ts:98`, `packages/backend/src/ws/index.test.ts:26`).
- Storage/cache/query: covered - Profile files are temporary and cleaned up; audit reservation is rooted under workspace tasks, no-follow, non-hardlink, and identity-checked before append (`packages/core/src/tools/raw-data-sandbox.ts:716`, `packages/core/src/tools/raw-data-sandbox.ts:4909`).
- Public routes/entrypoints: out-of-scope - Matrix states no full backend WS route in M1; only skeleton builders are changed and tested (`openspec/changes/m1-foundation/design.md:173`, `packages/backend/src/ws/index.ts:50`).
- Frontend/downstream consumers: covered - Existing `tool.failed` envelope/payload shape is asserted; no new WS event type is introduced (`packages/backend/src/ws/index.test.ts:26`, `packages/backend/src/ws/index.test.ts:228`).
- Failure paths/rollback/stale state: covered - Advisory/audit/profile/setup failures return failed `ToolResult`s, skip unsafe execution where required, finish running handles, and post-exec process results remain generic instead of forged `denied_by_sandbox` (`packages/core/src/tools/raw-data-sandbox.ts:641`, `packages/core/src/tools/raw-data-sandbox.ts:702`, `packages/core/src/tools/policy-gate-registry.ts:241`).
- Evidence/audit/readiness: covered - Trusted raw-denial evidence is built from one payload into ToolResult/audit/WS inputs, then identity/proof-gated for WS use (`packages/core/src/tools/raw-data-sandbox.ts:1178`, `packages/core/src/tools/raw-data-sandbox.ts:1204`, `packages/backend/src/ws/index.ts:87`).
- Regression row: six escape classes: covered - Interpreter payload, pipeline/stdin, dynamic target, shell child/grandchild, symlink/`../`, rename/unlink are tested as byte-blocked without sandbox-denial telemetry overclaim (`packages/core/src/tools/raw-data-sandbox.test.ts:933`).
- Regression row: legal raw read and workspace write: covered - Raw reads, denial-like raw read output, raw-to-workspace copy, workspace writes, and waited foreground child behavior are covered (`packages/core/src/tools/raw-data-sandbox.test.ts:1986`, `packages/core/src/tools/raw-data-sandbox.test.ts:2037`).
- Regression row: pre-existing hardlink residual: covered - Residual is demonstrated honestly and bounded `nlink>1` scan flags risk under explicit protected roots only (`packages/core/src/tools/raw-data-sandbox.test.ts:4443`, `packages/core/src/tools/raw-data-sandbox.ts:1407`).
- Regression row: obvious static raw write advisory: covered - Static same-root raw write can pre-deny with remediation/audit evidence; uncertain/dynamic misses fall through to sandbox authority (`packages/core/src/tools/raw-data-sandbox.test.ts:3272`, `packages/core/src/tools/raw-data-sandbox.test.ts:3300`).
- Regression row: Zero unchanged: covered - CI checks `zero` diff and pinned HEAD; local inspection also showed `zero` at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` with no diff (`.github/workflows/ci.yml:42`).

Findings:
None.

Non-blocking notes:
None.
