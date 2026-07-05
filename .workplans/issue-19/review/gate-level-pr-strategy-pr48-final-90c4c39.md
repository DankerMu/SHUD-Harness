# Gate-Level PR Strategy Review - PR #48 final 90c4c39 boundary snapshot closure

Current head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`
Context: post-gate final track after `e4f00c3` environment/lifecycle invariant closure and the follow-up comprehensive six-reviewer round on `90c4c39`.

## Deep Review Failure Retro

Repeated or moving failure classes:
- `state identity / mutable configuration`: fuse rule object mutation was closed, but sibling root arrays remained mutable and can move the protected raw root after construction.
- `process lifecycle`: direct un-awaited Python `Popen` was closed, but lexical fake waits (`sys.exit(0); p.wait()` / unreachable wait) still allow a child to outlive wrapper terminal state.
- `environment boundary`: common ambient secret names and host identity variables were stripped, but broad `LC_*` passthrough keeps an arbitrary secret-shaped namespace.
- `terminal state`: stale profile-root/setup failures now finalize handles, but pre-execute `fuseCheck()` failures still bypass wrapper finalization.

Why prior fixes did not close the invariant:
- Fixture scope gap: no. #19 and the OpenSpec fixture require stable raw byte authority, faithful observable evidence, and wrapper-owned lifecycle state.
- Fix prompt too narrow: yes. The prior pass fixed the cited mutable objects and cited env names but did not generalize to sibling caller-owned arrays, wildcard env namespaces, fake-wait control flow, or pre-execute fuse failure.
- Reviewer contract vague/inconsistent: no. All four candidates were independently verified as constructible on the current head.
- Missing regression evidence: yes. No tests covered post-construction root-array mutation, arbitrary `LC_*` ambient variables, unreachable Python waits, or running-handle finalization for fuse denial.
- PR too broad / should split: not yet. These defects remain inside #19's SHUD bash wrapper/config/lifecycle boundary. A split may be required if this class remains after the next class-level closure.

## Gate-Level PR Strategy Review

Direction check:
- The PR is still solving the accepted #19 problem: execution-layer seatbelt authority for raw bytes, fail-open advisory, faithful lifecycle/audit/WS evidence, and zero source diff.

Architecture/refactor check:
- The current code shape is close, but the wrapper still lacks a single immutable boundary snapshot. The stronger action is not another line fix: snapshot all caller-owned configuration at construction/factory boundaries, constrain process-env inheritance to finite names, and centralize wrapper-owned early failures into finalization.

Loop check:
- Findings continue to move across sibling surfaces because the implementation is closing cited values instead of the boundary class. The next fix must audit all array/object/env/control-flow/fuse pre-exec siblings named below.

Functionality root-cause check:
- Raw byte authority is sound under stable configuration, but mutable root arrays can change the profile target after construction; that is a root-cause authority defect.

Security/safety root-cause check:
- `LC_*` wildcard inheritance and mutable config state are security boundary defects. The Popen fake-wait and fuse terminal gap are lifecycle/evidence defects that can make UI/audit state lie even when raw bytes remain protected.

Decision:
- Continue with one stronger invariant-closure fix inside PR #48. No product/scope decision is needed; the issue/OpenSpec already makes these wrapper boundaries in scope.
- Do not run another comprehensive review until this closure is implemented, locally verified, committed, and pushed.

Execution plan:
- Implementer fix:
  - Snapshot all caller-owned root arrays at `RawDataSandboxedBashTool` construction and SHUD factory/registry boundaries: `protectedRawPaths`, `allowedWriteRoots`, `protectedEvidencePaths`, and `fuseRules`. Prefer immutable internal arrays or frozen copies.
  - Add direct constructor and `createShudSandboxedBashTool()` regressions that mutate original root arrays after construction; original raw root remains protected, raw bytes unchanged, and audit/profile identity remains bound to original roots.
  - Replace broad `LC_*` passthrough with a finite exact locale allowlist or remove it entirely except explicitly named safe locale keys. Add `LC_API_KEY`/`LC_PASSWORD` sentinel tests; keep explicit `envSecrets` redaction and intended locale behavior.
  - Make Python assigned `Popen` waited proof conservative. Preserve immediate chained wait/communicate and the current positive straight-line `p=Popen(...); sys.exit(p.wait())` case, but reject fake/unreachable waits such as `sys.exit(0); p.wait()` and multiline `if False:\n p.wait()`.
  - Ensure pre-execute fuse denial finalizes `runningToolRegistry` metadata. Move fuse checking into an execution path that returns through `finalizeToolResult()`, or override/wrap `run()` so wrapper-owned pre-execute failures mark the handle.
- Verification:
  - `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
  - `pnpm --package=bun@1.2.19 dlx bun run check`
  - `openspec validate m1-foundation --strict --no-interactive`
  - `git diff --check`
  - `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json`
  - `git -C zero diff --quiet && git -C zero rev-parse HEAD`
- Review:
  - After this closure, rerun exactly one comprehensive six-reviewer review on the new head.
  - If any critical/major finding remains in these same boundary families, re-enter this strategy review and choose PR split or a deeper wrapper redesign instead of another narrow patch.

## Invariant Surface Inventory

- Shared helper roots: `RawDataSandboxedBashTool` constructor/run/execute/fuseCheck, `resolveRawDataSandboxRuntimeRoots`, `createShudSandboxedBashTool`, `createShudRuntimeToolRegistry`, `createRawDataWriteAdvisoryRule`, `buildSanitizedToolProcessEnv`, Python process preflight helpers, running-tool finalization helpers.
- Public entrypoints: `RawDataSandboxedBashTool.run`, SHUD sandboxed bash factory, runtime tool registry, backend WS `tool.failed` builders, package root exports.
- Read surfaces: root arrays, environment variables, secret refs, interpreter payload scanner, fuse rules.
- Write/delete/overwrite surfaces: seatbelt profile generation, sandboxed bash process, audit append, workspace side effects, running-tool terminal metadata.
- Producer/consumer evidence boundaries: root config -> profile id/metadata -> audit row; secret resolver/filter -> child env/stdin -> output redaction; process preflight -> lifecycle audit decision; fuse check -> failed `ToolResult` -> running metadata.
- Stale-state/idempotency boundaries: caller mutates config after factory return, host env mutates before spawn, Python child continues after wrapper completion, pre-execute error skips finalization.
- Unchanged downstream consumers: raw read/workspace write positive cases, waited foreground `Popen`, explicit `envSecrets`, generic WS builder snapshotting, fuse rule object snapshotting, zero source pin.

## Regression Matrix

- Direct tool constructor with mutable `protectedRawPaths` changed after construction -> original `data/raw` write remains denied/byte-blocked.
- SHUD factory with mutable `protectedRawPaths` and `allowedWriteRoots` changed after construction -> original raw root remains protected; profile/audit identity remains original.
- Mutable `protectedEvidencePaths` after construction -> original evidence path remains protected, no caller mutation changes audit/profile safety.
- Parent env contains `LC_API_KEY=ambient-secret` and `LC_PASSWORD=ambient-secret` -> child output/env omit key/value; explicit `envSecrets` still pass and redact.
- Intended exact locale key, if retained (for example `LC_ALL` or `LC_CTYPE`) -> behavior documented and tested without wildcard passthrough.
- Python `Popen(...).wait()` chained and `p=Popen(...); sys.exit(p.wait())` -> allowed foreground child can write workspace.
- Python `p=Popen(...); sys.exit(0); p.wait()` and multiline `if False:\n p.wait()` -> process-containment failure; no immediate or delayed workspace file; audit decision `policy_gate_process_containment_unavailable`.
- Fuse-denied command with `TestRunningToolRegistry` -> failed result and handle terminal metadata `{cause:"completed", success:false}`.
- Existing raw byte six escape classes, hardlink residual, WS error snapshot, fuse object snapshot, stale root finalization -> remain green.
- Zero invariant: `git -C zero diff --quiet` and HEAD remains `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Post-gate budget

- After this root-cause corrective action, run exactly one comprehensive six-reviewer review.
- If that review reports any critical/major finding in the same wrapper/config/env/process lifecycle invariant family, do not return to ordinary line-item repair. Re-enter this strategy review and choose a stronger action: split PR #48, revise fixture scope, or redesign the wrapper boundary.
