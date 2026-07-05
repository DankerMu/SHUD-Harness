# Gate-Level PR Strategy Review - PR #48 da20028 boundary/state closure

Current head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Context: post-gate final track after prior gate packages, b246582 invariant closure, and da20028 cleanup/public-boundary fixes.

Repeated or moving failure classes:
- `public-boundary`: root export whitelist -> test-support subpath under `@shud-harness/core/*`; typed XOR source -> runtime merged object with both rule sources.
- `host-process-safety`: stale child PID -> root PID reuse -> timeout/abort re-owning current root PID from `ps`.
- `resource-bounds`: hardlink scan budget -> timeout input lacks runtime finite/min/max bounds.
- `state-transition`: normal completion cleanup -> pre-exec profile failure bypasses wrapper finalization.

Why prior fixes did not close the invariant:
- Fixture scope gap: no. The issue and OpenSpec fixture require bounded runtime behavior, faithful telemetry, and public API boundary control.
- Fix prompt too narrow: yes. Prior fixes removed several concrete leaks but did not audit the subpath alias, runtime input validation, or every pre-exec terminal failure.
- Reviewer contract vague/inconsistent: no. All five da20028 candidates were independently verified as constructible.
- Missing regression evidence: yes. No regression covered double-source fuse config, invalid/huge timeout, root PID reuse during timeout/abort, or running registry with profile-root failure.
- PR too broad / should split: not yet. These findings remain within #19 raw sandbox / wrapper lifecycle / public boundary acceptance. If the next comprehensive review reports the same invariant family again, split process-tracker/public-boundary cleanup into a smaller PR or revise scope with a recorded decision.

Direction check:
- The PR is still solving #19: byte authority remains OS sandboxing, advisory is observable, waited foreground subprocess compatibility remains in scope, and audit/tool.failed evidence remains bounded and faithful.

Architecture/refactor check:
- The code shape is close but still too trusting at boundaries. Stronger action: centralize runtime validation for wrapper inputs, remove package-like subpath bypasses, stop re-owning root PIDs from process-table snapshots, and ensure every wrapper-owned terminal failure runs through the same finalization path.

Loop check:
- Findings are still moving between sibling surfaces under the same boundary/state invariant. Continue only with one class-level invariant closure, not line-by-line patching.

Functionality root-cause check:
- The core feature contract is sound; the remaining work is boundary hardening around configuration, process lifetime, public imports, and pre-exec failure state.

Security/safety root-cause check:
- Remaining safety work is about not disabling fuse rules through untyped merges, not exposing test seams as package subpaths, not accepting unbounded timeout input, and not signaling unrelated host processes after PID reuse.

Decision:
- Continue with one stronger invariant-closure fix over public/config boundary, process/resource boundary, and terminal-state boundary. Do not merge until a new comprehensive six-reviewer pass is clean on the next head and final review is clean.

Execution plan:
- Implementer fix:
  - Add runtime exactly-one-source validation for `ShudBashFuseSource` and regression coverage for both fields present.
  - Remove or narrow the `@shud-harness/core/*` alias and move test-only raw sandbox support outside `packages/core/src` if needed, so package-like subpath imports cannot reach test seams. Update tests accordingly and add an import-boundary regression/proof.
  - Add finite/min/max runtime timeout validation, align tool schema metadata, and test invalid/huge timeout.
  - Refactor timeout/abort cleanup so root signaling does not re-own a root PID from `ps`; root kill must be tied to the original process handle/known process group, and descendant cleanup must only target current descendants proven safe.
  - Catch profile build/write failures into structured `ToolResult`s that pass through `finalizeToolResult()`, and test `runningToolRegistry` finalization for symlinked `profileRoot`/`tempRoot`.
- Verification:
  - Focused policy/raw/backend WS suite.
  - Full check, OpenSpec strict, diff checks, zero pin.
- Review:
  - Rerun comprehensive six-reviewer follow-up on the next head.
  - If any finding in this same invariant family remains, stop ordinary repair and choose PR split/scope revision rather than another narrow patch.

Invariant Surface Inventory:
- Shared helper roots: `resolveShudBashFuseRules`, `runSeatbeltSandboxedBash`, `RawDataSandboxedBashTool.execute`, `createInvocationDescendantTracker`, `terminateInvocationProcesses`, `listCurrentInvocationProcesses`, raw sandbox test-support helpers, TypeScript path aliases.
- Public entrypoints: `RawDataSandboxedBashTool.run`, `createShudBashTool`, `createPolicyGatedShudBashTool`, `@shud-harness/core` root import, `@shud-harness/core/*` subpath resolution.
- Read surfaces: fuse list loading, process table read, timeout input read, profile/temp root canonicalization.
- Write/delete/overwrite surfaces: process signaling, audit append, profile file creation/cleanup.
- Producer/consumer evidence boundaries: raw advisory evidence -> trusted `ToolResult` -> audit/WS; test-only helpers -> backend tests only.
- Stale-state/idempotency boundaries: timeout/abort after root exit, PID reuse, pre-exec throw before wrapper finalization, double invocation of cleanup.
- Unchanged downstream consumers: backend/frontend root imports, package root barrel exports, policy-gate registry wrappers, existing backend WS tests.

Regression Matrix:
- Merged fuse config with `fuseRules: []` and `fuseListPath` -> stable misconfiguration failure, not silent empty fuse rules.
- `@shud-harness/core/tools/raw-data-sandbox-test-support` from production tsconfig -> not resolvable or otherwise blocked; tests still import support through non-public path.
- Timeout `0`, negative, non-finite, or larger than max -> stable tool failure before `setTimeout`; valid timeout still works.
- Timeout/abort after root PID reuse -> no signal to reused root PID/group from `ps` re-ownership.
- Current child still owned by live invocation during timeout/abort -> containment still kills it.
- Symlinked `profileRoot` or `tempRoot` with `runningToolRegistry` -> failed `ToolResult` and running handle marked finished.

Post-gate budget:
- After this closure, run one comprehensive six-reviewer review.
- If any critical/major finding in the same invariant family remains, re-enter this strategy review and choose PR split or scope revision instead of another ordinary fix loop.
