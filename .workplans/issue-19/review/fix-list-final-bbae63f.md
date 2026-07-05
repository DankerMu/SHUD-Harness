# Fix List for PR #48 — final follow-up bbae63f

Reviewed head SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Verdict table: `.workplans/issue-19/review/verdict-table-final-bbae63f.md`

Pattern escalation: yes
Failure classes:
- `host-process-safety` / `resource-runtime-bounds`
- `telemetry-reserved-decision-integrity`

Pattern escalation trigger:
- Descendant tracker resource/runtime findings repeated across adjacent follow-up rounds: first unbounded full-process-table polling, then insufficient real-path evidence, then stale PID destructive cleanup risk.

Invariant:
- The sandboxed bash wrapper may bound and clean up invocation descendants, but it must not perform unbounded process-table work or signal host processes that are no longer provably part of the current invocation.
- Reserved denial decisions (`denied_by_advisory`, `denied_by_sandbox`) must not be emitted through public generic telemetry/audit paths without the trusted raw-denial source.

Invariant Surface Inventory:
- Shared helper roots: `createInvocationDescendantTracker`, `terminateInvocationProcesses`, `killKnownInvocationPids`, `buildToolFailedWsEvent`, `appendPolicyGateAuditRow`.
- Public entrypoints: `RawDataSandboxedBashTool.run`, `buildToolFailedWsEvent`, `buildRawDataAdvisoryToolFailedWsEvent`, `appendPolicyGateAuditRow`.
- Read surfaces: process parent table reads, stream captures, trusted `ToolResult` evidence reads.
- Write/delete/overwrite surfaces: process signaling, audit append, WS event emission.
- Producer/consumer evidence boundaries: raw advisory evidence -> trusted `ToolResult` -> backend WS; public generic `tool.failed`; public audit append.
- Stale-state/idempotency boundaries: historical descendant PIDs, sampled-but-exited child processes, repeated cleanup after normal completion.
- Unchanged downstream consumers: raw byte seatbelt profile, registry fuse wrapper, generic lifecycle `tool.failed`, hardlink scan.

Surfaces intentionally out of scope:
- Complete arbitrary descendant lifecycle ownership after a process has deliberately escaped and is no longer provably part of the invocation, per ADR/OpenSpec boundary.
- Runtime hardening for invalid JS/`any` objects containing both `fuseRules` and `fuseListPath`; record as non-blocking follow-up.

Fix 1: Add real-path bounded sampling evidence (P2)
Problem:
- Existing regression only checks the exported schedule helper, not `createInvocationDescendantTracker.start()` on the real path.
Required behavior:
- A normal successful long-running command must not keep sampling indefinitely at 100ms cadence.
- Timeout/abort/final teardown forced sampling must remain covered.
Test:
- Add a behavior-level or injectable-adapter regression that proves the real tracker path performs at most the bounded schedule for normal successful execution.

Fix 2: Guard reserved denial decisions in public telemetry/audit paths (P2)
Problem:
- Public builders reject reserved raw-denial decisions only when `rule === RAW_DATA_WRITE_RULE_ID`.
Required behavior:
- Generic public WS and audit paths must reject `denied_by_advisory` and `denied_by_sandbox` decisions regardless of rule value unless they are on the trusted raw advisory path.
- Keep trusted raw advisory builder working for `denied_by_advisory`.
Tests:
- Backend WS public builder rejects `decision="denied_by_sandbox"` with another rule and with no rule.
- Core public audit append rejects `decision="denied_by_sandbox"` with another rule and with no rule.
- Existing trusted advisory WS/audit tests remain green.

Fix 3: Avoid stale PID destructive cleanup on normal completion (P2)
Problem:
- Tracker stores historical numeric PIDs. Normal completion still performs kill cleanup over every historical PID/process group.
Required behavior:
- Normal successful completion must not signal stale historical PIDs that are no longer provably current invocation descendants.
- Timeout/abort containment must still kill live, provable invocation descendants before they can leak writes.
- If identity validation is added, do it at the helper level and test it; if normal completion is changed to verification-only cleanup, preserve audit/path safety tests that rely on delayed background containment.
Tests:
- Add a deterministic unit/helper test or adapter-backed regression for PID reuse/stale PID: a sampled child exits, PID is reused for an unrelated process, and cleanup must not signal it.
- Keep timeout/abort descendant containment tests passing.
- Keep delayed audit subtree move and detached audit ancestor move tests passing.

Non-blocking follow-up:
- Consider runtime XOR validation for `fuseRules` / `fuseListPath` in a later hardening pass; verifier marked it plausible but not merge-blocking for this typed contract.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`
