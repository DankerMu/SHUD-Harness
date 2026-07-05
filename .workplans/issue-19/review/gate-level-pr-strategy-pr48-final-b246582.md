# Gate-Level PR Strategy Review — PR #48 b246582 tracker/API boundary reset

Current head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Context: post-gate final track after prior gate package and multiple invariant-closure passes.

Repeated or moving failure classes:
- `host-process-safety`: unbounded process-table polling -> stale child PID reuse -> root PID reuse before identity sample -> same-second `lstart` collision.
- `telemetry-provenance`: mutable trusted WS evidence -> public reserved decisions -> mutable audit row TOCTOU -> public reserved-denial builder exposure.
- `resource-bounds`: descendant sampling bound -> hardlink scan root canonicalization before budget.

Why prior fixes did not close the invariant:
- Fixture scope gap: no. The issue requires bounded hardlink scan, reserved telemetry integrity, and safe wrapper resource/process behavior.
- Fix prompt too narrow: yes. Tracker fixes kept trying to enrich PID identity rather than removing destructive normal-completion signaling.
- Reviewer contract vague/inconsistent: no. Findings had concrete scenarios and file evidence.
- Missing regression evidence: yes. Several fixes lacked sibling-surface tests until later rounds.
- PR too broad / should split: no. All remaining findings are still within #19 raw sandbox / telemetry / bounded scan acceptance.

Direction check:
- The PR is still solving #19 correctly: execution-layer seatbelt authority, advisory observability, bounded residual hardlink scanning, and trusted telemetry.

Architecture/refactor check:
- The tracker architecture is fighting the requirement when it tries to prove historical PID identity after normal completion. Stronger action: normal completion must not perform destructive cleanup from historical process state. Timeout/abort may signal the root process group while the wrapper still owns the process handle, then only signal current descendants proven by live parent-chain state.

Loop check:
- Findings are moving among sibling surfaces under the same invariants. Continue only with a class-level closure over public API exports, audit input snapshotting, hardlink scan budgeting, and tracker cleanup semantics.

Functionality root-cause check:
- Core feature remains sound: raw byte authority is seatbelt, legal reads/writes and waited child remain allowed, hidden telemetry remains out of scope.

Security/safety root-cause check:
- Remaining safety work is not about raw bytes; it is about not overclaiming public telemetry and not signaling host processes outside the invocation.

Decision:
- Continue with one stronger invariant-closure fix. Do not add another PID identity refinement. Remove destructive normal-completion cleanup and close public API / input snapshot / budget boundaries.

Execution plan:
- Implementer fix:
  - Normal completion: stop periodic tracker; do not signal any process from historical PID state. Preserve timeout/abort root process-group kill and parent-chain current descendant cleanup.
  - Remove root identity acceptance when no known root identity exists, or remove identity-based historical cleanup entirely.
  - Move test-only tracker helpers out of package root exports or hide them behind a test-only module not exported by `@shud-harness/core`.
  - Stop exporting reserved-denial builders from package root; keep internal trusted construction working.
  - Snapshot public audit rows before any await and write only the snapshot.
  - Make hardlink scan budget cover root canonicalization, with sequential bounded root handling.
- Verification:
  - Focused policy/raw/backend WS suite.
  - Full check, OpenSpec strict, diff checks, zero pin.
- Review:
  - Rerun comprehensive six-reviewer follow-up on the next head.
  - If this same host-process/public-telemetry invariant family appears again, do not continue line-item repair; split the process tracker surface from #19 or revise OpenSpec scope with a recorded decision.

Invariant Surface Inventory:
- Shared helper roots: `createInvocationDescendantTracker`, `terminateInvocationProcesses`, public audit append helpers, raw-denial payload/tool-result builders, hardlink scan helpers, `tools/index.ts` barrel exports.
- Public entrypoints: `RawDataSandboxedBashTool.run`, `appendPolicyGateAuditRow`, package root exports, backend WS builders.
- Read surfaces: process table read, hardlink root canonicalization, trusted `ToolResult` reads.
- Write/delete/overwrite surfaces: process signaling, audit append, WS event emission.
- Producer/consumer evidence boundaries: raw advisory evidence -> trusted `ToolResult` -> WS/audit; public package API -> downstream consumers.
- Stale-state/idempotency boundaries: normal completion after `proc.exited`, stale PID sets, mutable input object across await.
- Unchanged downstream consumers: registry wrapper, seatbelt profile, generic lifecycle WS events, hardlink scan caller surface.

Regression Matrix:
- Normal completed invocation with no trusted root identity sample and reused root PID -> no signal.
- Known child PID reused with same-second identity string -> no signal unless still parent-chain current under live root.
- Timeout/abort with live descendant in root process group -> no leak.
- Public audit row mutated after call start -> snapshot prevents reserved row write.
- Package root import -> no `ForTest` / internal tracker helpers and no reserved-denial builders.
- Hardlink scan with many roots and tiny budget -> fails before unbounded concurrent realpath.

Post-gate budget:
- After this stronger closure, run one comprehensive six-reviewer review.
- If any critical/major finding in the same invariant family remains, re-enter this strategy review and choose PR split or scope revision rather than another narrow patch.
