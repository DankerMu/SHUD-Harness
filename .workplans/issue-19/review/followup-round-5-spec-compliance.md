# PR #48 round 5 review - spec compliance

Reviewer agent: review-spec-compliance
Review round: round 5 comprehensive convergence check
Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Summary: #19 主路径基本收敛；仍有 3 个候选缺口集中在 public policy-gate 组合、重复包装语义和已有 raw 文件截断证明。

Invariant Matrix Coverage:
- Governing raw read/write invariant: covered with caveat - seatbelt profile denies `file-write*` for raw/evidence roots (`packages/core/src/tools/raw-data-sandbox.ts:185-200`), wrapper executes through `sandbox-exec` (`raw-data-sandbox.ts:326-345`), six escape classes are tested (`raw-data-sandbox.test.ts:65-144`); existing-file overwrite/truncation proof is missing, see Finding 3.
- Source-of-truth identity/contract: partially missing - internal sandbox/advisory denials produce `raw_data_write_denied`, `ErrorRecord.remediation`, profile id, audit row, and WS-compatible input (`raw-data-sandbox.ts:547-677`; `packages/backend/src/ws/index.ts:36-53`), but exported central raw advisory composition can return generic `policy_gate_denied`, see Finding 1.
- Producers: covered - profile builder, wrapper, advisory evaluator, audit helper, hardlink scanner, and WS builder are present (`raw-data-sandbox.ts:144-235`, `261-443`, `477-543`, `679-741`; `index.ts:36-53`).
- Validators/preflight: covered with caveat - advisory positives/false-open/raw-read tests exist (`raw-data-sandbox.test.ts:262-496`); central-rule specialized evidence is not tested, see Finding 1.
- Storage/cache/query: covered - profile file uses per-run `mkdtemp` + exclusive write and cleanup (`raw-data-sandbox.ts:218-235`, `355-356`); audit reservation validates workspace/task/audit path (`raw-data-sandbox.ts:1711-1743`).
- Public routes/entrypoints: covered for M1 scope - no full WS route added; only `tool.failed` skeleton builder exists (`packages/backend/src/ws/index.ts:20-53`), tests assert no `policy.denied` event (`index.test.ts:38`).
- Frontend/downstream consumers: out-of-scope - design explicitly limits this to future AgentActivityFeed consumption and M1 envelope shape (`openspec/changes/m1-foundation/design.md:173-174`).
- Failure paths/rollback/stale state: covered with caveat - audit-root/raw-root/symlink/hardlink/sabotage tests cover stale evidence paths (`raw-data-sandbox.test.ts:733-877`); generic public policy gate denial does not persist raw audit evidence, see Finding 1.
- Evidence/audit/readiness: partially missing - internal denial rows match payload (`raw-data-sandbox.test.ts:1143-1158`); public central raw-advisory composition lacks the same proof.
- Six escape classes: covered - interpreter, pipeline/stdin, dynamic target, child/grandchild, symlink/`../`, rename/unlink (`raw-data-sandbox.test.ts:65-144`).
- Legal raw read and workspace write: covered - raw read, denial-like raw output, read-to-workspace, and workspace write tests (`raw-data-sandbox.test.ts:262-357`).
- Hardlink residual and bounded scan: covered - residual mutation is demonstrated and scan is protected-root-only/budgeted (`raw-data-sandbox.test.ts:879-945`; `raw-data-sandbox.ts:679-741`).
- Advisory behavior: partially covered - internal advisory produces raw denial evidence (`raw-data-sandbox.test.ts:422-465`); exported policy rule composition gap remains, see Finding 1.
- Zero unchanged: covered - observed `zero` clean at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- No oracle weakening: covered - `package.json` adds sandbox/backend tests to `check` (`package.json:11-14`); OpenSpec validation passed; no schema/policy-core diff observed.

Findings:
- Severity: P1
  Failure class: contract
  Violated contract/invariant: `policy-gate-spike` requires advisory and OS denials to return the same remediation/ErrorRecord shape, emit `tool.failed`, and write audit evidence with profile identity (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23-25`, `44-47`).
  Evidence: `createRawDataWriteAdvisoryRule` returns a central `PolicyRuleDecision` (`packages/core/src/tools/raw-data-sandbox.ts:455-472`), but `PolicyGatedBaseToolAdapter.run` returns immediately through `buildPolicyGateDeniedResult` (`packages/core/src/tools/policy-gate-registry.ts:231-247`), whose payload is only `policy_gate_denied` with no `ErrorRecord`, profile id, `tool.failed` input, or audit append (`policy-gate-registry.ts:257-273`).
  Concrete scenario: A caller builds `createShudRuntimeToolRegistry({ evaluate: createPolicyGateEvaluator({ rules: [createRawDataWriteAdvisoryRule([rawRoot])] }), ... })` and runs `bash` with `printf nope > data/raw/obvious.txt`; the central wrapper denies before `RawDataSandboxedBashTool` can build/persist raw denial evidence.
  Consequence: Raw bytes are likely protected, but the source-of-truth evidence contract is broken for the public advisory seam: no `raw_data_write_denied`, no profile id, no `ErrorRecord.remediation`, and no `workspace/tasks/TASK-M1-SPIKE/audit/` row.
  Fix direction: Either make raw advisory unusable through the generic policy wrapper and document/test that it is internal to `RawDataSandboxedBashTool`, or teach the wrapper/SHUD registry to route `raw-data-write` denials through the raw denial evidence builder and audit append path.
  Required verification: Add a regression for `createShudRuntimeToolRegistry + createRawDataWriteAdvisoryRule` asserting either same-shape raw denial evidence/audit or explicit construction failure.
  Sibling surfaces to audit: `createPolicyGatedToolRegistry` with plain `BashTool`, future policy rules that require specialized audit evidence, and any runtime config that installs raw advisory rules in the central gate.
  Blocking status: Blocking candidate for spec compliance unless this public composition is declared unsupported.
- Severity: P2
  Failure class: wrapper
  Violated contract/invariant: SHUD runtime registry must apply the current central policy gate to registered tools and fail closed on bypass (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:9-18`; `design.md:165`).
  Evidence: `wrapToolWithPolicyGate` returns an already policy-gated tool unchanged (`packages/core/src/tools/policy-gate-registry.ts:72-82`); `createShudRuntimeToolRegistry` relies on that wrapper for non-bash/non-spawn tools (`policy-gate-registry.ts:136-152`).
  Concrete scenario: `options.tools` contains an `edit` tool previously wrapped with an allow-all evaluator; `createShudRuntimeToolRegistry({ tools, evaluate: denyAll, ... })` returns that stale wrapper, so `edit.run()` still uses the old evaluator instead of the current runtime denial.
  Consequence: Assembly passes `assertPolicyGatedToolRegistry`, but the runtime policy evaluator does not actually govern every returned tool.
  Fix direction: Rewrap policy-gated tools when constructing a new SHUD runtime registry, or make `PolicyGatedTool` carry/verifiably match the active evaluator identity and reject stale wrappers.
  Required verification: Add a stale-wrapper regression where a prewrapped `edit` with allow evaluator is passed into `createShudRuntimeToolRegistry` with deny evaluator and must be denied.
  Sibling surfaces to audit: Any helper that treats `isPolicyGatedTool()` as sufficient proof, scoped registries copied across runtimes, and non-bash tools beyond `edit`.
  Blocking status: Non-blocking candidate unless the runtime migration may pass prewrapped tools; should be fixed or explicitly constrained.
- Severity: P2
  Failure class: test-evidence
  Violated contract/invariant: The governing invariant includes create, modify, delete, rename, and truncate of protected raw bytes (`openspec/changes/m1-foundation/design.md:167-168`, `188`).
  Evidence: Sandbox tests cover creating new raw targets and deleting/renaming (`packages/core/src/tools/raw-data-sandbox.test.ts:65-144`) but no sandbox-layer test writes over or truncates an existing raw file such as `data/raw/input.csv` with advisory disabled; `truncate`/`chmod` only appear in advisory classification checks (`raw-data-sandbox.test.ts:432-446`).
  Concrete scenario: A regression narrows the seatbelt/profile behavior or classification so `printf changed > data/raw/input.csv` or `truncate -s 0 data/raw/input.csv` mutates an existing raw file while new-file creation tests still pass.
  Consequence: The strongest wording of the invariant is not directly proven across the overwrite/truncation surface.
  Fix direction: Add at least one advisory-disabled sandbox test for existing-file overwrite/truncation and assert original bytes remain unchanged with `decision=denied_by_sandbox`.
  Required verification: Focused raw sandbox test for `printf changed > data/raw/input.csv` or `truncate -s 0 data/raw/input.csv` under the same profile.
  Sibling surfaces to audit: `dd of=data/raw/input.csv`, append redirection `>>`, metadata mutations (`chmod/chown/xattr`) if they are considered protected evidence mutation.
  Blocking status: Non-blocking candidate; acceptable to defer only if the team treats `file-write*` profile inspection plus creation/delete tests as sufficient proof.

Non-blocking notes:
- `openspec validate m1-foundation --strict --no-interactive` passed; `git diff --check` passed; `zero` is clean and pinned to `13e25c1`.
- I did not rerun the full Bun suite in this leaf read-only review; I reviewed the expanded test evidence and the provided local verification summary.
- `tasks.md:33` still leaves task 3.3 unchecked. I did not count that as a finding because broader M1 tasks are still open and the orchestrator may own final task-state updates.
