# PR #48 five-round gate package

PR: #48
Issue: #19
Current head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`
Comprehensive review rounds counted: 5

## Deep Review Failure Retro

Round SHAs/reports:

- Round 1: `8b3795c7c593638e19513a01c4100b3dc743ef43` — `.workplans/issue-19/review/verdict-table-pr48-round-1.md` — findings.
- Round 2: `2fa51433f837db2803a8eb511d2e6400aeeb3be3` — `.workplans/issue-19/review/verdict-table-pr48-round-2.md` — findings.
- Round 3: `353fd461a6f579a332e2a320a589118f74b123a3` — `.workplans/issue-19/review/verdict-table-pr48-round-3.md` — findings.
- Round 4: `1c18247d9acaac53d751186526ee5f35fb9907b6` — `.workplans/issue-19/review/verdict-table-pr48-round-4.md` — findings.
- Round 5: `3acdba26d142cff9f9b004975fa5e29dca327dd5` — `.workplans/issue-19/review/verdict-table-pr48-round-5.md` — findings.

Repeated or moving failure classes:

- Denial classification / false allowed / generic failed state: rounds 1, 2, 3, 4, 5. The finding moved from `|| true` and output-text parsing to direct `$d/$r` operands, `pathlib.joinpath`, and `sed -i`/`perl -pi` normalization.
- Audit/evidence durability: rounds 1, 2, 3, 4, 5. The finding moved from missing WS projection and symlink/hardlink poisoning to appendability and post-reservation append failure.
- Registry/wrapper composition: rounds 1, 2, 4, 5. The finding moved from live runtime unguarded bash and spawn scoped registries to stale policy wrappers and outer raw advisory composition.
- Wrapper observability/profile leakage: rounds 4, 5. Round 5 narrowed it to timeout/running-tool terminal metadata.

Why prior fixes did not close the invariant:

- Fixture scope gap: no - 条 2' already requires execution-layer authority, legal read/write compatibility, remediation/tool.failed/audit evidence, hardlink residual honesty, and zero diff.
- Fix prompt too narrow: yes - prior fixes chased named shell/compiler patterns and named stale states instead of replacing the execution/evidence boundary with a single authority-owning abstraction.
- Reviewer contract vague/inconsistent: no - round 5 findings cite concrete code paths, commands, and required tests.
- Missing regression evidence: yes - no tests existed for fake `sandbox-exec` in PATH, outer raw advisory composition, stale prewrapped tools, non-writable regular audit file, direct `$d/$r` operands, `pathlib.joinpath`, `sed -i`/`perl -pi`, existing-file truncation, grouped `cd workspace`, or timeout terminal metadata.
- PR too broad / should split: no - all findings are inside the accepted #19 boundary: bash execution wrapper, registry/evaluator composition, audit evidence, and raw-denial classification. Splitting would leave the same invariant partly enforced.

## Gate-Level PR Strategy Review

Direction check:

- The PR is still solving the right issue/OpenSpec problem: `data/raw/**` write authority belongs at execution-layer OS sandbox, with advisory only as fail-open hinting and with synchronized evidence.
- The direction did drift at the implementation layer: the authority is currently invoked through a generic shell wrapper (`sandbox-exec ...` string via Zero `BashTool`), so the parent boundary still depends on shell/PATH semantics before authority starts.

Architecture/refactor check:

- The current shape is fighting the requirement. `RawDataSandboxedBashTool` delegates execution to a wrapped shell command instead of owning the sandbox subprocess, and generic policy wrappers can preempt raw evidence generation.
- A targeted refactor is required inside SHUD-owned code: introduce a sandbox-runner path that directly spawns the verified sandbox executable and owns result/audit/running-status evidence. Do not modify `zero/`.

Loop check:

- Findings are moving between sibling surfaces because prior patches strengthened individual detectors and stale-state checks without establishing one owner for launcher authority, raw-denial evidence, and registry wrapper identity.

Functionality root-cause check:

- The implementation does not yet fundamentally satisfy the feature contract. Raw bytes are usually protected, but prohibited attempts can still return `allowed`, generic failed, or generic policy-denied states; required evidence can still be missing.

Security/safety root-cause check:

- The OS sandbox principle is correct, but the launcher and evidence boundary is not fully safe: `sandbox-exec` is shell/PATH-resolved, raw-denial evidence can be bypassed by generic policy wrappers, and audit append durability is not proved before execution.

Decision:

- Continue with invariant closure through a focused refactor/redesign inside PR #48. No product/scope decision is needed; the issue/OpenSpec already dictates the behavior.
- Do not run another comprehensive review before this corrective action is implemented and locally verified.

Execution plan:

- Implement a SHUD-owned sandbox execution runner for `RawDataSandboxedBashTool`:
  - Spawn absolute `/usr/bin/sandbox-exec` directly with argv `["-f", profilePath, "/bin/bash", "-c", command]` or an equivalent verified absolute bash path; do not invoke the launcher through shell/PATH.
  - Preserve current `BashTool`-compatible input semantics needed by M1: command, timeout, envSecrets/stdinSecretRef validation, secret filtering, fuse rules, stdout/stderr capture, abort/timeout handling, and sanitized output summaries.
  - Remove `BASH_ENV`/`ENV` and shell-function injection vectors from the launcher environment while preserving normal command PATH inside the sandbox where compatible.
  - Own running-tool terminal metadata from the outer wrapper so no `sandbox-exec` or profile path reaches user-visible status.
- Make raw-denial evidence single-owner:
  - `RawDataSandboxedBashTool` owns raw advisory and OS-denial evidence. The generic policy wrapper must not preempt `RAW_DATA_WRITE_RULE_ID` for SHUD bash, or runtime construction must reject that composition with a clear error.
  - All raw-denial outcomes must return `raw_data_write_denied` with remediation triplet, `guard_class`, `profile_id`, `profile_path`, WS-compatible `ErrorRecord`, and an audit row.
- Make registry wrapper identity strong:
  - Rewrap or reject prewrapped tools in `createShudRuntimeToolRegistry` so the current evaluator governs every returned non-bash tool.
  - Keep spawn rebuilt against the final registry.
- Make audit durability fail-closed:
  - Prove final audit appendability before bash execution, preferably by opening/creating the audit file no-follow and validating file identity/appendability at reservation time, or by holding a safe append handle.
  - If appendability cannot be guaranteed, return `policy_gate_audit_unavailable` before running bash.
  - Denial append failures after execution must not be swallowed as normal denial success.
- Replace pattern chase with regression matrix coverage:
  - Add tests for fake `sandbox-exec` in PATH, `BASH_ENV`/env prelude safety, outer raw advisory composition, stale prewrapped tool, non-writable audit file/dir, direct `$d/$r`, `pathlib.joinpath`, `sed -i`/`perl -pi`, overwrite/truncation of existing raw file, grouped `cd workspace`, and timeout/running metadata.
- Verification commands:
  - `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`
  - `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
  - `pnpm --package=bun@1.2.19 dlx bun run check`
  - `openspec validate m1-foundation --strict --no-interactive`
  - `git diff --check`
  - `git -C zero diff --quiet && git -C zero rev-parse HEAD`

## Invariant Surface Inventory

- Shared helper roots: `RawDataSandboxedBashTool`, sandbox profile builder, sandbox runner, advisory classifier, sandbox-denial classifier, audit reservation/append helpers, policy-gate registry wrappers, WS `tool.failed` builder.
- Public entrypoints: `RawDataSandboxedBashTool.run`, `createShudSandboxedBashTool`, `createShudRuntimeToolRegistry`, `wrapToolWithPolicyGate`, `createPolicyGatedToolRegistry`, `appendPolicyGateAuditRow`, `buildToolFailedWsEvent`.
- Read surfaces: `data/raw/**` reads through sandboxed bash, hardlink metadata scan under explicit protected roots, audit row reads in tests.
- Write/delete/overwrite surfaces: raw writes/deletes/renames/truncation via shell/interpreter/tool commands, profile/temp roots, audit file append, evidence namespace under `workspace/tasks`, workspace-allowed writes.
- Staging/publish/rollback surfaces: profile file create/cleanup, timeout/abort subprocess teardown, no source changes in `zero/`.
- Producer/consumer evidence boundaries: advisory/sandbox denial -> `ToolResult` raw payload -> `ErrorRecord` -> WS `tool.failed` -> audit row; allowed/failed profiled calls -> audit row with profile identity.
- Stale-state/idempotency boundaries: pre-existing audit files/dirs, symlink/hardlink audit state, non-writable audit state, prewrapped policy tools, captured spawn registry, environment/PATH/BASH_ENV state.
- Unchanged downstream consumers: Zero `BashTool` contract semantics where SHUD wrapper exposes `bash`, policy-gate pure evaluator, backend WS skeleton, future AgentActivityFeed, future full AuditEvent.

## Regression Matrix

- Absolute launcher: fake `sandbox-exec` earlier in `PATH` + dynamic raw write -> real `/usr/bin/sandbox-exec` still applies; raw unchanged; raw-denial payload/audit.
- Environment prelude: `BASH_ENV` attempts raw write before command -> no raw mutation and no allowed audit for prohibited attempt.
- Legal workspace compatibility: grouped/subshell `{ cd workspace; ... }`, `(cd workspace && ...)`, `bash -c 'cd workspace && ...'` write `workspace/data/raw/out.txt` -> allowed.
- Direct shell variable target: `d=data; r=raw; printf x > "$d/$r/direct.txt" 2>/dev/null || true` -> denied_by_sandbox; no allowed audit.
- Interpreter constructors: Python `Path("data").joinpath("raw", ...)`, Node/Ruby path join variants with swallowed/suppressed errors -> denied_by_sandbox.
- In-place tools: `sed -i`, `perl -pi`, one R/Python in-place or file-modifying form targeting raw -> raw unchanged; denied_by_sandbox.
- Existing raw mutation: `: > data/raw/input.csv`, append `>>`, `truncate -s 0`, `dd of=data/raw/input.csv` -> raw bytes unchanged; denied_by_sandbox or documented hardlink residual only where applicable.
- Audit appendability: non-writable regular audit file/dir, stale file replacement after reservation, public `appendPolicyGateAuditRow` on unsafe state -> fail before bash or return evidence-persistence failure; no silent normal result.
- Registry composition: prewrapped allow `edit` passed to deny SHUD runtime -> current deny evaluator governs; zero inner calls.
- Raw advisory composition: exported `createRawDataWriteAdvisoryRule` installed in outer evaluator for SHUD bash -> either construction rejects as unsupported or result is same raw denial evidence/audit shape.
- Timeout/running status: sandboxed timeout/abort -> terminal metadata contains original user command summary only; no `sandbox-exec` or profile path leak; abort remains functional.
- Zero invariant: `git -C zero diff --quiet` and HEAD remains `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Post-gate budget

- After this root-cause corrective action, run at most one comprehensive cross-review.
- If that review reports any critical/major finding in the same launcher/evidence/registry invariant family, do not return to narrow line-item repair. Re-enter this strategy review and choose a stronger action: deeper wrapper refactor, PR split, fixture revision, or explicit user scope decision if the issue/OpenSpec cannot resolve it.
