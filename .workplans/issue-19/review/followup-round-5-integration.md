# PR #48 round 5 review - integration

Reviewer agent: review-integration
Review round: round 5 comprehensive convergence check
Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Summary: Candidate convergence gaps remain: dynamic raw-write evidence can still be masked, reused wrapped tools can keep stale policy, and wrapper/audit edge paths still leak or drop required evidence.

Invariant Matrix Coverage:
- Governing raw-byte invariant: covered - seatbelt profile protects canonical raw paths and hardlink residual is bounded; evidence classification gap remains in Finding 1.
- Source-of-truth identity/contract: missing - runtime denial/audit/profile identity can be skipped on direct variable-composed raw writes and post-reservation audit append failures.
- Producers: missing - sandbox wrapper, dynamic classifier, and registry wrapper have producer/consumer gaps in Findings 1, 2, and 5.
- Validators/preflight: missing - tests cover `p="$d/$r/..."` but not direct `"$d/$r/..."`, pre-wrapped registry inputs, subshell-cwd advisory false positives, or timeout running-status leakage.
- Storage/cache/query: covered with gap - audit path reservation and no-follow append are strong, but append failures are caught and suppressed after reservation.
- Public routes/entrypoints: covered - `buildToolFailedWsEvent` skeleton preserves `tool.failed` shape; full WS bus is out-of-scope.
- Frontend/downstream consumers: out-of-scope - future AgentActivityFeed is not implemented in this slice.
- Failure paths/rollback/stale state: missing - masked dynamic writes can return allowed, timeout/abort status can expose wrapper internals, and audit append failures can drop mandatory rows.
- Evidence/audit/readiness: missing - hardlink scan is covered, but denial/audit rows are not guaranteed for all dynamic raw-write and append-failure paths.
- Six escape classes: missing - dynamic target coverage misses direct data/raw variable composition; see Finding 1.
- Legal raw read and workspace write: missing - simple cases are covered, but grouped/subshell `cd workspace` can be advisory-denied; see Finding 3.
- Advisory behavior: missing - advisory both misses a dynamic raw-write sibling and can block a legal workspace write sibling.
- Zero clean/pinned: covered - inspected `zero` HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` with no diff output.

Findings:
- Candidate 1
  Severity: P1
  Failure class: data-integrity
  Violated contract/invariant: dynamic `data/raw/**` write attempts must return remediation-shaped `raw_data_write_denied`, emit `tool.failed`, and persist an audit row; masked denials must not look allowed.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:513`, `packages/core/src/tools/raw-data-sandbox.ts:1333`, `packages/core/src/tools/raw-data-sandbox.ts:1415`, `packages/core/src/tools/raw-data-sandbox.ts:1534`.
  Concrete scenario: `d=data; r=raw; printf masked > "$d/$r/direct.txt" 2>/dev/null || true` is a raw write, but `collectDynamicRawPathVariables()` only promotes assigned raw-candidate variables such as `p="$d/$r/x"`; direct `"$d/$r/x"` redirection leaves `rawCandidateVariables` empty, stderr is suppressed, the shell exits 0, and `isLikelySandboxDenialForCommand()` has no denial output to classify.
  Consequence: raw bytes remain protected, but the wrapper can return success and append `decision=allowed` instead of returning remediation/tool.failed/audit evidence for a denied raw-write attempt.
  Fix direction: detect direct operands/redirections that combine known `data` and `raw` variables, or fail closed for failure-hiding write forms that reference both variables without requiring an intermediate raw-candidate variable.
  Required verification: add tests for masked and unmasked direct `"$d/$r/file"` redirection, plus sibling `tee`, `cp`, `dd of=`, `mv`, and `install` forms; assert raw unchanged, result `raw_data_write_denied`, decision `denied_by_sandbox`, and audit row matches payload.
  Sibling surfaces to audit: child shell `bash -c`, grouped commands, interpreter payloads that build path from separate variables, and static advisory rule reuse.
  Blocking status: Blocking candidate for convergence.
- Candidate 2
  Severity: P1
  Failure class: wrapper
  Violated contract/invariant: the SHUD runtime registry's supplied evaluator must govern every returned tool; scoped/reused registries must not keep stale policy decisions.
  Evidence: `packages/core/src/tools/policy-gate-registry.ts:72`, `packages/core/src/tools/policy-gate-registry.ts:76`, `packages/core/src/tools/policy-gate-registry.ts:146`.
  Concrete scenario: a caller passes `tools: [wrapToolWithPolicyGate(new RecordingTool("edit"), { evaluate: allow })]` into `createShudRuntimeToolRegistry({ evaluate: deny, ... })`; `wrapToolWithPolicyGate()` returns the already-wrapped tool unchanged, so `edit` still uses the old allow evaluator while `assertPolicyGatedToolRegistry()` passes.
  Consequence: non-bash tools can bypass the current runtime policy gate even though the registry reports all tools as policy-gated.
  Fix direction: in `createShudRuntimeToolRegistry`, unwrap known `PolicyGatedTool.innerTool` and rewrap with the current evaluator, or reject pre-wrapped tools when the policy domain cannot be proven identical.
  Required verification: add a test where a prewrapped allow `edit` is supplied to a deny runtime registry; expected result is policy denial and zero inner calls.
  Sibling surfaces to audit: `createPolicyGatedToolRegistry`, `wrapAllRegisteredTools`, spawn scoped registry construction, and any future registry composition that accepts previously wrapped tools.
  Blocking status: Blocking candidate for convergence.
- Candidate 3
  Severity: P2
  Failure class: contract
  Violated contract/invariant: legal workspace writes must execute under the sandbox without advisory false denial; static/advisory checks should fail open when cwd analysis is uncertain.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:486`, `packages/core/src/tools/raw-data-sandbox.ts:828`, `packages/core/src/tools/raw-data-sandbox.ts:1160`.
  Concrete scenario: `mkdir -p workspace/data/raw; (cd workspace && printf ok > data/raw/out.txt)` writes only under `workspace/data/raw`, but `splitStaticShellSegments()` splits on `&&` without understanding the subshell, the cwd command token becomes `(cd` rather than `cd`, and the later relative `data/raw/out.txt` is treated as protected.
  Consequence: default advisory mode can block a legal workspace write, despite the OS sandbox being able to allow it correctly.
  Fix direction: treat grouped/subshell/function cwd changes as ambiguity and fail open for relative `data/raw` advisory decisions, or defer these cases to the OS sandbox instead of static denial.
  Required verification: add legal workspace-write tests for `(cd workspace && ...)`, `{ cd workspace; ...; }`, and `bash -c 'cd workspace && ...'`, with and without stderr/exit masking.
  Sibling surfaces to audit: `pushd/popd`, nested child shells, shell functions, and advisory-only `evaluateRawDataWriteAdvisory()` callers.
  Blocking status: Non-blocking P2 candidate; should fix or explicitly defer.
- Candidate 4
  Severity: P2
  Failure class: async
  Violated contract/invariant: wrappers must preserve observable return/status semantics without leaking the sandbox wrapper command or profile path.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:326`, `packages/core/src/tools/raw-data-sandbox.ts:778`, `packages/core/src/tools/raw-data-sandbox.ts:786`, `zero/packages/core/src/tool/bash.ts:344`, `zero/packages/core/src/tool/bash.ts:418`.
  Concrete scenario: for a timed-out sandboxed command, inner `BashTool` still sees the original `currentToolUseId` and `runningToolRegistry`, so it can mark the live handle finished with `Command timed out: sandbox-exec -f <profile> bash -c ...` before the outer wrapper normalizes the returned `ToolResult`.
  Consequence: session running-tool status can expose transient profile paths and report the wrapped command; the outer agent's later normalized status may be ignored because the handle is already finished.
  Fix direction: pass a running-tool proxy that preserves abort wiring but sanitizes/defers terminal metadata, or give the inner tool an internal tool-use id and let the outer wrapper own the user-visible status.
  Required verification: add timeout and abort tests with a fake or real `runningToolRegistry`, asserting no `sandbox-exec` or profile path appears in terminal metadata and timeout/abort cause is preserved.
  Sibling surfaces to audit: spawn errors, stdin secret write failures, background tool execution, and observability/tracer status paths.
  Blocking status: Non-blocking P2 candidate; should fix or explicitly defer.
- Candidate 5
  Severity: P2
  Failure class: data-integrity
  Violated contract/invariant: every sandboxed bash call must persist audit evidence with profile identity, and every denial must either persist durable evidence or fail closed.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:365`, `packages/core/src/tools/raw-data-sandbox.ts:372`, `packages/core/src/tools/raw-data-sandbox.ts:392`, `packages/core/src/tools/raw-data-sandbox.ts:407`, `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25`.
  Concrete scenario: after successful reservation, if the audit append throws later due to a concurrent audit-path replacement, permission change, or filesystem error, both `appendDenialAudit()` and `appendAudit()` only log a warning and still return the original tool result.
  Consequence: a denial or allowed sandboxed call can be reported without the mandatory audit row/profile identity, leaving downstream evidence incomplete.
  Fix direction: make audit append failure part of the returned tool failure, or write to a parent-owned fallback that is outside sandbox-writable state; at minimum distinguish "command result" from "evidence persistence failed".
  Required verification: add an injected or race-controlled append-failure test after reservation; assert the tool does not silently return normal success/denial without durable audit evidence.
  Sibling surfaces to audit: public `appendPolicyGateAuditRow()`, allowed-call audit rows, advisory pre-denials, OS sandbox denials, and cleanup/finally paths.
  Blocking status: Non-blocking P2 candidate; should fix or explicitly defer.

Non-blocking notes:
- Review was static/read-only. I did not rerun the supplied verification commands because this shell does not have `bun` on PATH; I treated the user-provided local verification summary as existing evidence, not as a substitute for the integration gaps above.
