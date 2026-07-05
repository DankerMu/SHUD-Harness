Reviewer agent: review-security-perf
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190

Summary: Not clean; raw-byte path safety fixes hold, but one trusted raw-denial WS evidence mutability gap remains.

Invariant Matrix Coverage:
- Governing raw-byte invariant: covered - direct raw writes and broad-root raw ancestor moves are denied by seatbelt; focused tests include raw ancestor move at sandbox and registry level.
- Source-of-truth identity/contract: covered - OpenSpec/ADR/plan text narrows M1 telemetry to trusted advisory/static evidence and leaves post-exec OS attribution out of scope.
- Producers: missing - sandbox-owned evidence is produced, but the trusted WS event input remains mutable after publication; see Finding 1.
- Validators/preflight: covered - advisory is fail-open for uncertainty, bounded, and covered for static writes, raw reads, workspace writes, and over-budget paths.
- Storage/cache/query: covered - audit file nofollow/hardlink checks, profile cleanup identity checks, stream capture caps, and hardlink scan budgets are present.
- Public routes/entrypoints: partial - no full WS route is added, but the exported WS builder can emit tampered trusted raw-denial payload fields through a mutable WeakMap value; see Finding 1.
- Frontend/downstream consumers: partial - `tool.failed` envelope shape is tested, but downstream consumers would receive tampered raw-denial payloads if the mutable trusted input is altered first.
- Failure paths/rollback/stale state: covered - raw ancestor displacement, audit subtree movement, timeout/abort descendants, and stale audit targets are covered by tests.
- Evidence/audit/readiness: missing - raw-denial evidence is no longer structurally cloneable, but it is still caller-mutable after retrieval; see Finding 1.
- Regression row, six escape classes: covered - focused raw sandbox suite passed and includes interpreter, pipeline/stdin, dynamic target, child shell, symlink/`../`, rename/unlink, and suppressed/over-budget variants.
- Regression row, raw read and workspace write: covered - same-profile raw read, raw-to-workspace copy, workspace writes, and waited foreground subprocess writes are covered.
- Regression row, pre-existing hardlink residual: covered - residual behavior is demonstrated and bounded `nlink > 1` scan detects risk under explicit protected roots.
- Regression row, advisory denial: partial - advisory denial emits remediation/audit/WS-shaped evidence, but the WS evidence fields can be mutated after trust; see Finding 1.
- Regression row, zero unchanged: covered - `zero` diff is clean and HEAD remains `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Resource/performance row: covered - command analysis, interpreter payloads, call scans, process preflight, output capture, and hardlink scans are bounded; no new unbounded file handle or stream issue found.

Findings:
- Severity: P2
  Failure class: Evidence provenance / mutable trusted capability
  Contract or invariant: Raw-denial `tool.failed` telemetry must be derived from sandbox-owned trusted evidence for the actual `ToolResult`; caller-authored or tampered payload fields must not become fresh trusted telemetry.
  Scenario or repro: A same-process caller obtains a real advisory-denial `ToolResult`, calls exported `rawDataDeniedToolResultToToolFailedEventInput(result)`, mutates the returned object or nested `error` fields, then calls `buildRawDataAdvisoryToolFailedWsEvent({ seq, toolResult: result })`. The backend resolves the same mutable object from the WeakMap and emits the mutated `profileId`, `invocationId`, `error_id`, remediation, or message because it only checks `rule` and `decision`.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:963` stores the mutable `toolFailedEventInput` object by `ToolResult`; `packages/core/src/tools/raw-data-sandbox.ts:1024` returns that same object; `packages/core/src/tools/raw-data-sandbox.ts:1030` has proof validation but `packages/backend/src/ws/index.ts:98` does not call it; `packages/backend/src/ws/index.ts:107` only checks `rule` and `decision`; clone tests at `packages/backend/src/ws/index.test.ts:67` do not cover post-trust mutation.
  Consequence: A caller with a legitimate trusted result can author false raw-denial WS details, weakening profile/audit/event lineage and misleading future downstream evidence consumers.
  Fix direction: Treat trusted event data as immutable evidence: store a frozen/deep-frozen snapshot, return defensive clones from public helpers, and have the WS builder re-run `assertTrustedRawDataToolFailedEventInput` or an equivalent snapshot proof before emitting. Avoid exposing the mutable object used as the trust source.
  Required test or evidence: Add a regression that obtains a real trusted advisory result, mutates the returned trusted input and nested `error`, then asserts `buildRawDataAdvisoryToolFailedWsEvent({ toolResult })` rejects or emits the original immutable snapshot. Also cover mutation of the `ToolResult` object after trust if identity remains the capability.
  Sibling surfaces: `rawDataDeniedToolResultToToolFailedEventInput`, `assertTrustedRawDataToolFailedEventInput`, backend raw advisory WS builder, future audit/WS bus, any future non-test caller of the exported helper.
  Blocks merge: Yes for the high-risk evidence-provenance fixture.

Non-blocking notes:
- Verification run locally: focused 171-test suite passed; full `pnpm --package=bun@1.2.19 dlx bun run check` passed; `openspec validate m1-foundation --strict --no-interactive` passed; both diff-check commands passed; zero diff/head check passed.
- `pnpm` emitted the existing workspace warning, but all invoked commands exited 0.

Execution Summary: agents=review-security-perf; skills=review; tools=git/rg/sed/nl/pnpm+bun/openspec/seatbelt probe; verification=focused tests, full check, OpenSpec validate, diff checks, zero diff/head; limits=read-only, no edits/commits/PR comments/subagents.
