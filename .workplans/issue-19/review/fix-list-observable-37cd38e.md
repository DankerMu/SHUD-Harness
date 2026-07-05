# Fix List -- PR #48 observable 37cd38e

Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

## Fix Group 1 -- observable denial classification

Severity: P1.
Failure classes: observable-denial evidence, evidence/audit state classification, over-budget false denial.
Candidates: `cand-observable-37-01`, `cand-observable-37-03`, `cand-observable-37-04`.

Invariant:
- `raw_data_write_denied` may be emitted only when an observable OS/advisory denial is tied to a raw write target.
- Visible sandbox denial output tied to a known raw write target must produce remediation-shaped failure/audit even if shell normalizes final exit to 0.
- Hidden/no-output/suppressed denials remain out of telemetry scope.
- Over-budget analysis must not classify unrelated `Permission denied` as raw denial from output text alone.

Required changes:
- Make post-exec classification return raw denial when denial output is visible and a bounded raw-write target signal is known, regardless of final exit status.
- Remove the over-budget output-only raw-denial shortcut. Generic permission failures stay generic when target evidence is incomplete.
- Add bounded symlink-aware classification for literal workspace symlink destinations when the target can be resolved under the configured roots without broad traversal. If resolution is unavailable/inconclusive, keep generic.
- Preserve legal raw-read cases whose stdout contains denial-like text.

Required tests:
- visible symlink-only raw alias write -> `raw_data_write_denied`, `decision=denied_by_sandbox`, no raw mutation.
- visible `|| true` or `; true` raw write with known raw target -> `raw_data_write_denied`, denial audit, no raw mutation.
- suppressed/no-output variant -> no false denial telemetry, no raw mutation.
- over-budget raw read or unrelated workspace permission failure -> generic failed result/audit, no `raw_data_write_denied`.

## Fix Group 2 -- outer policy-gate deny and wrapper API contract

Severity: P1/P2.
Failure classes: wrapper, policy-gate deny bypass, wrapper/proxy faithfulness.
Candidates: `cand-observable-37-02`, `cand-observable-37-06`.

Invariant:
- An explicit central policy-gate deny must not execute the underlying tool.
- Exported wrapper options must not imply wrapped BashTool fuse/lifecycle preservation when not implemented.

Required changes:
- For outer `raw-data-write` deny, return/emit denial evidence without running the inner tool. If raw-denial evidence needs profile/audit metadata, build it from the shared sandbox configuration rather than executing bash.
- Ensure `enableAdvisory: false` or stale inner protected roots cannot bypass an outer deny.
- Resolve `RawDataSandboxedBashToolOptions.innerTool` ambiguity: either remove the option from the exported constructor surface and require `fuseRules`, or implement faithful composition of inner fuse/lifecycle behavior. Prefer the smaller option that matches current factory usage and keeps public API honest.

Required tests:
- registry outer raw deny with inner advisory disabled -> no side effect, denial result/evidence.
- stale/mismatched outer deny root vs inner protected root -> no write to outer-denied raw path.
- compile/runtime test proving `innerTool` cannot silently drop fuses, or a test proving inner fuse is honored if composition is implemented.

## Fix Group 3 -- CI skip gating and bounded resources

Severity: P2, CI blocking for skip gating.
Failure classes: test-evidence, resource/performance, preflight boundedness.
Candidates: `cand-observable-37-05`, `cand-observable-37-07`, `cand-observable-37-08`.

Invariant:
- Real seatbelt/interpreter runtime tests must skip cleanly when the authority or interpreter is unavailable.
- Pre-exec scans must be bounded.
- Long-running foreground commands must not create excessive steady-state host polling or unbounded output memory growth.

Required changes:
- Convert runtime `runSandboxed()` tests that require seatbelt/interpreters to `seatbeltTest`, `nodeSeatbeltTest`, `pythonSeatbeltTest`, etc. Keep pure helper tests as plain `test`.
- Fix the `/tmp` profile-text assertion so it is portable across Linux/macOS temp-root canonicalization.
- Add or reuse a process-preflight budget and avoid full-command/full-payload scans beyond it. Fail open for over-budget process-preflight advisory unless there is a clear explicit session/background signal inside budget.
- Coarsen descendant sampling or make steady-state polling less aggressive, and cap stdout/stderr capture with explicit truncation metadata that does not break existing ToolResult callers.

Required tests/proof:
- `bun run check` passes on macOS and Linux CI.
- over-budget process-preflight input returns promptly and does not block before sandbox execution.
- output capture truncates large output deterministically.
- waited foreground child remains allowed.

## Verification floor after fixes

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
