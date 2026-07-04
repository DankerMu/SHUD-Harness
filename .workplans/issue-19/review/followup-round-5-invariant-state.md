# PR #48 round 5 review - invariant state

Reviewer agent: review-invariant-state
Review round: round 5 comprehensive convergence check
Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Summary: Raw bytes are now largely protected by the seatbelt wrapper, but convergence is not complete: several denial/evidence state paths can still diverge from the required raw-data policy contract.

Invariant Matrix Coverage:
- Governing invariant: missing - seatbelt coverage protects many raw-byte mutation paths, but findings below show attempted raw writes can still be reported as allowed/generic failure instead of `raw_data_write_denied`.
- Source-of-truth identity/contract: missing - outer policy-gate advisory denial can bypass profile/audit identity; post-exec audit append failures are swallowed.
- Producers: missing - `RawDataSandboxedBashTool`, raw advisory rule, generic policy wrapper, and audit helper do not compose to one denial shape on all paths.
- Validators/preflight: missing - tests cover named masks, but not outer raw advisory in SHUD runtime, `pathlib.joinpath`/equivalent suppressed interpreter writes, or unrecognized write tools like `sed -i` / `perl -pi`.
- Storage/cache/query: missing - reservation is fail-closed, but final audit append failure after execution is warning-only.
- Public routes/entrypoints: covered - full WS route/session bus is explicitly out-of-scope; skeleton builder shape is tested.
- Frontend/downstream consumers: covered - M1 only asserts `tool.failed` skeleton payload shape; no frontend consumer is in this PR.
- Failure paths/rollback/stale state: missing - hidden sandbox denials and final audit persistence failure can produce stale or misleading state.
- Evidence/audit/readiness: missing - audit rows are present for covered tests, but not guaranteed across all raw-write denial paths.
- Six escape classes: missing - named tests pass by inspection, but sibling interpreter-fragment + shell suppression still escapes denial classification.
- Legal raw read and workspace write: covered - tests cover raw read, denial-like raw-read output, raw-to-workspace copy, and workspace writes.
- Pre-existing hardlink residual: covered - residual is demonstrated and bounded `nlink>1` scanner is limited to explicit protected roots.
- Advisory-deny behavior: missing - internal advisory path is shaped correctly, but the exported advisory rule can be used through the generic runtime wrapper and lose required raw denial evidence.
- Zero unchanged: covered - `zero` is clean and pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- Severity: P1
  Failure class: wrapper
  Violated contract/invariant: Advisory and OS-layer raw-write denials must return the same remediation-shaped raw-data error family and bind to profile/audit identity.
  Evidence: `packages/core/src/tools/policy-gate-registry.ts:155` wraps the sandboxed bash tool in the generic policy gate; `packages/core/src/tools/policy-gate-registry.ts:231` evaluates policy before `innerTool.run`; `packages/core/src/tools/policy-gate-registry.ts:245` returns generic denial; `packages/core/src/tools/policy-gate-registry.ts:261` emits `policy_gate_denied` without profile/audit fields; `packages/core/src/tools/raw-data-sandbox.ts:455` exports a raw advisory rule that can deny at that outer layer.
  Concrete scenario: Build `createShudRuntimeToolRegistry({ evaluate: createPolicyGateEvaluator({ rules: [createRawDataWriteAdvisoryRule([rawRoot])] }), ... })`, then run `bash` with `printf x > data/raw/x.txt`. The outer wrapper denies before `RawDataSandboxedBashTool` reserves audit, builds a profile, or emits `raw_data_write_denied`.
  Consequence: An obvious raw write can be blocked with no `profile_id`, no raw denial payload, no raw audit row, and no WS-compatible raw `tool.failed` input, violating the required advisory-deny evidence contract.
  Fix direction: Keep `RAW_DATA_WRITE_RULE_ID` out of the outer generic gate for SHUD bash, or special-case/delegate that decision into `RawDataSandboxedBashTool` so the internal evidence path always owns raw advisory denial.
  Required verification: Add a runtime-registry test that installs `createRawDataWriteAdvisoryRule`, invokes an obvious raw write, and asserts `raw_data_write_denied`, `decision=denied_by_advisory`, `profile_id`, remediation triplet, and audit row.
  Sibling surfaces to audit: `createPolicyGatedToolRegistry`, custom `evaluate` callers, spawn-scoped registries, and any future raw-data policy rule registered in the generic policy gate.
  Blocking status: Blocking candidate for #19.
- Severity: P1
  Failure class: state-transition
  Violated contract/invariant: A raw-write attempt whose sandbox denial is hidden by shell status/stderr manipulation must not transition to `allowed`.
  Evidence: Hidden-denial precheck only denies when static/dynamic raw-write signals are detected at `packages/core/src/tools/raw-data-sandbox.ts:497`; interpreter write detection requires a recognized raw path signal at `packages/core/src/tools/raw-data-sandbox.ts:1023`; fragmented path patterns omit forms like `Path("data").joinpath("raw", ...)` at `packages/core/src/tools/raw-data-sandbox.ts:1104`; post-exec classification returns false when output is empty at `packages/core/src/tools/raw-data-sandbox.ts:1539`; allowed audit is then written at `packages/core/src/tools/raw-data-sandbox.ts:348`.
  Concrete scenario: `python3 -c 'from pathlib import Path; Path("data").joinpath("raw","hidden.txt").write_text("x")' 2>/dev/null || true`. Seatbelt blocks the write, stderr is suppressed, shell exits 0, and the current classifier has neither denial output nor a recognized fragmented raw path.
  Consequence: Raw bytes remain unchanged, but the tool can return success and append `tool.completed` / `decision=allowed`, teaching downstream state that a prohibited raw write was acceptable.
  Fix direction: Make hidden-denial handling fail closed for write-capable interpreter payloads that can suppress errors, or expand raw-fragment detection enough to cover common path constructors without relying on exact string `data/raw`.
  Required verification: Add a macOS seatbelt regression for the `pathlib.joinpath` suppressed write and equivalent Node/Ruby path-constructor siblings; assert denied result, no raw mutation, `decision=denied_by_sandbox`, remediation, and audit row.
  Sibling surfaces to audit: Python `pathlib`, Node `path.join` variants, Ruby `File.join`, Perl/Rscript write helpers, and shell-level `2>/dev/null || true` / `; true` masks.
  Blocking status: Blocking candidate for #19.
- Severity: P1
  Failure class: contract
  Violated contract/invariant: OS-layer runtime raw-write denials must be normalized to the same remediation-shaped denial family, not generic command failures.
  Evidence: Failed-result normalization requires `hasFailedResultRawWriteSignal` at `packages/core/src/tools/raw-data-sandbox.ts:1550`; static write detection recognizes only a fixed command set at `packages/core/src/tools/raw-data-sandbox.ts:865`; raw literal write signal repeats a narrow allowlist at `packages/core/src/tools/raw-data-sandbox.ts:1574`; generic failed audit is written at `packages/core/src/tools/raw-data-sandbox.ts:348`.
  Concrete scenario: `sed -i '' 's/raw/changed/' data/raw/input.csv` or `perl -pi -e 's/raw/changed/' data/raw/input.csv` attempts to modify raw input. Seatbelt denies the syscall, but these commands are not in the write-signal list, so the wrapper can return the underlying `Command failed` result and audit `decision=failed` instead of `denied_by_sandbox`.
  Consequence: The mutation is blocked, but the policy-gate evidence contract is broken: no raw-data remediation payload, no raw denial classification, and no audit row that states the raw-write rule denied the attempt.
  Fix direction: Normalize failed `sandbox-exec` denials from protected raw operands independently of the narrow pre-exec command allowlist, or explicitly cover the standard write-capable tools expected in the fixture and hydrology workflows.
  Required verification: Add seatbelt tests for at least `sed -i`, `perl -pi`, and one R/Python file-modification form; assert `raw_data_write_denied`, `decision=denied_by_sandbox`, raw unchanged, and audit/profile identity.
  Sibling surfaces to audit: `sed`, `perl -pi`, `Rscript`, `awk` file writes outside the existing case, archive extraction into raw, and any command that writes via in-place temp/rename semantics.
  Blocking status: Blocking candidate for #19.
- Severity: P1
  Failure class: data-integrity
  Violated contract/invariant: Every raw-write denial must either persist mandatory audit evidence or fail closed before bash execution when that evidence cannot be persisted.
  Evidence: `appendDenialAudit` catches and suppresses append failures at `packages/core/src/tools/raw-data-sandbox.ts:365`; the warning-only path continues at `packages/core/src/tools/raw-data-sandbox.ts:372`; generic audit append has the same swallow behavior at `packages/core/src/tools/raw-data-sandbox.ts:407`; the spec requires audit minimum rows for denials at `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25`.
  Concrete scenario: Audit reservation succeeds, bash runs and hits a raw sandbox denial, then the audit target becomes unavailable before final append due to concurrent stale state, permissions, disk error, or another tool mutating the audit subtree. The wrapper returns a raw denial result but records no durable audit row.
  Consequence: The user-facing tool result and durable evidence diverge; downstream verification cannot prove the denial occurred or bind it to the profile/run identity.
  Fix direction: Do not swallow final denial-audit append failures. Surface audit persistence failure in the returned result and/or write to a parent-owned fallback that the sandboxed command cannot alter.
  Required verification: Add a deterministic test hook or fixture that makes final append fail after reservation and assert the call does not silently return a normal raw denial without durable audit evidence.
  Sibling surfaces to audit: Allowed-call audit rows, direct `appendPolicyGateAuditRow`, edit/tool writes to `workspace/tasks`, and future full AuditEvent persistence.
  Blocking status: Blocking candidate for #19.

Non-blocking notes:
- Read-only checks confirmed the reviewed HEAD and zero submodule state; no files were modified.
- The hardlink residual handling and zero clean-state requirements look covered at this round.
