# PR #48 round 5 review - security performance

Reviewer agent: review-security-perf
Review round: round 5 comprehensive convergence check
Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Summary: Raw syscall enforcement and audit-path hardening look substantially covered, but two wrapper/evidence composition gaps remain as blocking candidate findings.

Invariant Matrix Coverage:
- Governing raw-byte invariant: covered - seatbelt profile denies `file-write*` on protected raw paths in `packages/core/src/tools/raw-data-sandbox.ts:184`, with six escape-class regression coverage in `packages/core/src/tools/raw-data-sandbox.test.ts:65`.
- Legal raw read and workspace write: covered - raw reads, raw-read false-denial text, raw-to-workspace copy, and workspace writes are covered in `packages/core/src/tools/raw-data-sandbox.test.ts:262`.
- Advisory static raw write: missing - inner `RawDataSandboxedBashTool` advisory is covered, but exported policy-gate advisory composed through the outer runtime wrapper bypasses profile/audit evidence; see finding 2.
- Evidence/audit/profile identity: partially covered - inner advisory/sandbox denials append audit rows with profile identity, but outer policy-gate denial returns generic `policy_gate_denied`; see finding 2.
- Audit path poisoning and protected evidence namespace: covered - reservation plus `workspace/tasks` protection is in `packages/core/src/tools/raw-data-sandbox.ts:271` and safe append checks are in `packages/core/src/tools/raw-data-sandbox.ts:1711`; stale symlink/hardlink and command-side sabotage tests cover `packages/core/src/tools/raw-data-sandbox.test.ts:733`.
- Hardlink residual and bounded scan: covered - explicit-root `opendir` traversal with budget is in `packages/core/src/tools/raw-data-sandbox.ts:679`, with residual demonstration and budget tests in `packages/core/src/tools/raw-data-sandbox.test.ts:879`.
- Runtime registry wrapping: missing - raw bash replacement and spawn rebuild are covered, but already policy-gated non-bash tools can retain a stale evaluator; see finding 1.
- WebSocket `tool.failed` skeleton: covered within M1 non-goal boundary - builder preserves payload/error/remediation shape in `packages/backend/src/ws/index.ts:36`; full session bus emission remains out of scope.
- Zero source cleanliness: covered - local read-only check confirmed `zero` diff is clean and HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Resource/performance bounds: covered - hardlink scan is budgeted and closes directory handles; profile cleanup is scoped to the generated profile directory.

Findings:
1. Stale policy-gated tools can bypass the current runtime evaluator.
   Severity: P1
   Failure class: authorization
   Violated invariant/contract: `createShudRuntimeToolRegistry` must return a final registry whose tools obey the current runtime policy evaluator; a previously wrapped tool must not keep an older, less restrictive evaluator.
   Evidence: `wrapToolWithPolicyGate` returns an already policy-gated tool unchanged at `packages/core/src/tools/policy-gate-registry.ts:76`, while `createShudRuntimeToolRegistry` relies on that wrapper for supplied non-bash/non-spawn tools at `packages/core/src/tools/policy-gate-registry.ts:136`.
   Concrete scenario: Build an `edit` tool in an earlier registry with an allow evaluator, pass `oldRegistry.list()` into `createShudRuntimeToolRegistry({ evaluate: denyAll, ... })`, then call `registry.get("edit").run(...)`. The old wrapper is reused, so the deny evaluator is never bound and `edit` executes.
   Consequence: Role/tool policy can be bypassed for non-bash tools, including file-mutating tools, whenever a prewrapped registry is reused during SHUD runtime assembly.
   Fix direction: In SHUD runtime assembly, unwrap `PolicyGatedTool.innerTool` and rewrap with the final evaluator, or add a force-rewrap mode for `wrapToolWithPolicyGate`; keep spawn's explicit rebuild behavior.
   Required verification: Add a regression where an allow-wrapped `edit` is passed to `createShudRuntimeToolRegistry` with a deny evaluator; assert the result is `policy_gate_denied` and the underlying tool call count stays `0`.
   Sibling surfaces to audit: `createPolicyGatedToolRegistry`, `wrapAllRegisteredTools`, `createShudRuntimeToolRegistry`, spawn scoped registry construction, any future runtime factory accepting `BaseTool[]`.
   Blocking status: Blocking candidate.
2. Outer raw advisory policy can bypass mandatory raw-denial evidence.
   Severity: P1
   Failure class: contract
   Violated invariant/contract: Obvious static raw-write advisory denials must return the raw-data denial family with remediation, `guard_class`, profile identity, `tool.failed`-compatible payload, and audit row.
   Evidence: `createRawDataWriteAdvisoryRule` exports a deny-capable `PolicyRule` at `packages/core/src/tools/raw-data-sandbox.ts:455`; the runtime registry wraps sandboxed bash with the outer policy gate at `packages/core/src/tools/policy-gate-registry.ts:155`; outer denial returns generic `policy_gate_denied` before `RawDataSandboxedBashTool.execute` can reserve audit/profile evidence at `packages/core/src/tools/policy-gate-registry.ts:245`.
   Concrete scenario: Configure `createShudRuntimeToolRegistry` with `evaluate: createPolicyGateEvaluator({ rules: [createRawDataWriteAdvisoryRule([rawRoot])] })`, then run `printf nope > data/raw/x.txt`. The outer adapter denies first, so no profile is created, no raw-data audit row is appended, and the output is not `raw_data_write_denied`.
   Consequence: A natural composition of the exported raw advisory rule regresses the source-of-truth evidence contract while appearing to "work" because raw bytes are not mutated. Downstream audit/WS consumers lose `profile_id`, `guard_class`, and raw-denial correlation.
   Fix direction: Make raw-data advisory evidence owned by `RawDataSandboxedBashTool` only, or teach the outer policy adapter to delegate `raw-data-write` denials to the raw evidence builder/audit path instead of returning generic policy denial.
   Required verification: Add a runtime-registry test with `createRawDataWriteAdvisoryRule` in the evaluator and assert a static raw write yields `raw_data_write_denied`, full remediation, profile identity, and an audit row; alternatively assert runtime construction rejects that composition and documents the inner-only path.
   Sibling surfaces to audit: `createRawDataWriteAdvisoryRule`, `createPolicyGateEvaluator`, `PolicyGatedBaseToolAdapter`, backend `tool.failed` projection, audit append helpers, runtime factory call sites.
   Blocking status: Blocking candidate.

Non-blocking notes:
- I did not rerun Bun tests because `bun` is not available on this shell PATH. Static checks run here: `git diff --check` passed; `git -C zero diff --quiet` passed; zero HEAD matched `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
