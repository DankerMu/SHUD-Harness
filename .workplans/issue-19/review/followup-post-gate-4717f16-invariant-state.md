Reviewer agent: review-invariant-state
Review round: post-gate follow-up on 4717f16
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a
Summary: Not clean: profile/audit hardening improved, but dynamic fork/session descendants and over-budget hidden raw writes can still produce stale or false-allowed terminal state.

Invariant Matrix Coverage:
- producers/validators/profile identity: covered - audit is reserved before profile creation, the audit directory is included in `protectedEvidencePaths`, and recognized raw denials carry `profile_id`/`invocation_id` through payload, audit row, and WS skeleton (`packages/core/src/tools/raw-data-sandbox.ts:332`, `packages/core/src/tools/raw-data-sandbox.ts:340`, `packages/core/src/tools/raw-data-sandbox.ts:819`, `packages/backend/src/ws/index.ts:36`).
- subprocess lifecycle: missing - literal/Popen cases are covered, but obfuscated Python fork/session creation can bypass preflight and evade PPID-based descendant sampling (`packages/core/src/tools/raw-data-sandbox.ts:3480`, `packages/core/src/tools/raw-data-sandbox.ts:3587`, `packages/core/src/tools/raw-data-sandbox.ts:1681`).
- raw-root identity: covered - protected raw paths are canonicalized and denied by seatbelt literal/subpath rules while legal raw reads remain tested (`packages/core/src/tools/raw-data-sandbox.ts:167`, `packages/core/src/tools/raw-data-sandbox.ts:217`, `packages/core/src/tools/raw-data-sandbox.test.ts:2669`).
- evidence/audit/WS: missing - over-budget hidden raw-write attempts can fall through to `tool.completed/allowed`, so no raw-denial payload/audit/WS evidence is produced (`packages/core/src/tools/raw-data-sandbox.ts:674`, `packages/core/src/tools/raw-data-sandbox.ts:3789`, `packages/core/src/tools/raw-data-sandbox.ts:453`).
- compatibility: covered - prior over-budget legal raw-read/workspace-write and containment keyword false positives have positive regressions (`packages/core/src/tools/raw-data-sandbox.test.ts:1683`, `packages/core/src/tools/raw-data-sandbox.test.ts:2669`).

Findings:
- severity: P1
  failure class: process lifecycle containment / stale descendant mutation
  violated invariant/contract: A bash invocation must not leave invocation-owned descendants able to mutate workspace or evidence after the wrapper reaches a terminal ToolResult.
  concrete scenario: `python3 -c 'import os,time; f=getattr(os,"fork"); p=f(); os._exit(0) if p else None; getattr(os,"set"+"sid")(); p=f(); os._exit(0) if p else None; time.sleep(.3); open("workspace/post-return.txt","w").write("leaked")'` avoids the literal `os.fork(` / `os.setsid(` detectors, can reparent before final PPID sampling, and can write allowed workspace bytes after an `allowed` audit row.
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:3480` only runs static containment preflight; `packages/core/src/tools/raw-data-sandbox.ts:3587` detects only literal Python process APIs; `packages/core/src/tools/raw-data-sandbox.ts:3635` strips string literals before session checks, so computed `"set"+"sid"` is invisible; `packages/core/src/tools/raw-data-sandbox.ts:1681` reconstructs descendants only from current PPID ancestry; success rows are emitted at `packages/core/src/tools/raw-data-sandbox.ts:453`.
  consequence: The wrapper can report `tool.completed/allowed` while invocation-owned code continues mutating workspace state, reopening the stale descendant class despite the exact dynamic Popen regression being fixed.
  fix direction: Fail closed for interpreter process/session manipulation that cannot be proven foreground-contained, including dynamic `getattr`/reflection forms, or move containment to a runtime primitive that can reliably own/reap descendants.
  required test/proof: Add normal-return, timeout, and abort regressions using obfuscated fork/session descendants that attempt late workspace and audit-subtree mutation; assert failed containment or no late side effects plus matching running metadata.
  sibling surfaces: Node computed child_process imports, Ruby `send(:fork)`/daemon forms, R background process helpers, future RunJob executor, audit ancestor protection, timeout/abort cleanup.
  blocking status: blocking.
- severity: P1
  failure class: hidden-denial evidence / scan-budget false allowed
  violated invariant/contract: Raw write attempts denied by the OS sandbox must not be recorded as `tool.completed/allowed`; hidden-sensitive over-budget raw writes must fail closed or produce denial evidence.
  concrete scenario: `printf x > data/raw/over-budget-hidden.txt 2>/dev/null || true # ${"x".repeat(140000)}` exceeds the command-length budget, hides stderr, normalizes exit status, leaves raw bytes protected by seatbelt, and then reaches the generic success audit path.
  evidence (file:line): budget overflow returns no known raw target and no incomplete hidden scan at `packages/core/src/tools/raw-data-sandbox.ts:674`; suppressed-denial preflight no longer denies budget overflow at `packages/core/src/tools/raw-data-sandbox.ts:640`; post-exec budget handling only recognizes denial when `!result.success` and denial output exists at `packages/core/src/tools/raw-data-sandbox.ts:3789`; success is recorded as `allowed` at `packages/core/src/tools/raw-data-sandbox.ts:453`; tests cover over-budget legal positives but not this hidden raw-write negative at `packages/core/src/tools/raw-data-sandbox.test.ts:2669`.
  consequence: Raw bytes are not mutated, but ToolResult, audit, WS, and running metadata can falsely state that a protected raw mutation attempt was allowed.
  fix direction: Before budget bailout, run a bounded cheap scan for raw-path signals plus stderr/exit suppression and fail closed as `denied_by_advisory`; keep `denied_by_sandbox` only for observed OS denials.
  required test/proof: Add over-budget hidden raw-write tests for command length, segment count, and interpreter payload budget; assert no raw mutation, failed ToolResult, `tool.failed` audit/WS input, profile/invocation identity, and no legal over-budget regression.
  sibling surfaces: advisory-disabled wrapper path, registry outer raw rule, long generated R/Python/bash scripts, `outputSummary`/running metadata, WS skeleton conversion.
  blocking status: blocking.

Non-blocking notes:
- Prior cand-2689-02 and cand-2689-04 look materially closed for the stated legal over-budget and keyword-literal cases.
- Read-only review: no files were modified and the report target was not written.
- Execution Summary: agents=review-invariant-state; skills=review; tools=git,gh,rg,sed; verification=static diff/context trace, no tests run because `bun` was not on PATH; limits=read-only/no edits.
