# Gate-Level PR Strategy Review -- PR #48 post-gate 4717f16

PR: `#48`
Issue: `#19`
Reviewed head SHA: `4717f1608058418a279365b385afc17e35e2238a`
Prior strategy action: `.workplans/issue-19/review/gate-level-pr-strategy-pr48-post-gate-2689f1f.md`

## Current Gate Result

The allowed post-gate comprehensive follow-up review is not clean.

Confirmed findings:

- `cand-4717-01`: symlink alias hidden raw write can be denied by seatbelt while the wrapper records `tool.completed/allowed`.
- `cand-4717-02`: obfuscated process/session creation can leave stale descendants outside the wrapper's lifecycle accounting.
- `cand-4717-03`: over-budget hidden raw writes can hide stderr/exit and reach the success audit path.
- `cand-4717-04`: broad process-creation preflight rejects a legal waited foreground child process.

Evidence:

- `.workplans/issue-19/review/candidates-post-gate-4717f16.md`
- `.workplans/issue-19/review/verdict-table-pr48-post-gate-4717f16.md`
- `.workplans/issue-19/review/verify-cand-4717-01.md`
- `.workplans/issue-19/review/verify-cand-4717-02.md`
- `.workplans/issue-19/review/verify-cand-4717-03.md`
- `.workplans/issue-19/review/verify-cand-4717-04.md`

Gate status: blocked. Do not run Phase 7, do not post final merge evidence, and do not merge PR #48 on this head.

## Failure Pattern

The repeated failures are not isolated rule gaps. They are the same boundary error resurfacing after multiple narrow fixes: the wrapper is still trying to infer runtime mutation, denial telemetry, and descendant lifecycle facts from shell/program text plus post-hoc process sampling.

This contradicts the ADR-0001 revisit premise for #19: shell semantics are not statically decidable, so static pre-exec checks can only be advisory. The OS sandbox remains the authority for raw-byte mutation, but the current M1 wrapper primitive does not reliably expose denied syscall telemetry when the child process catches or suppresses the denial and exits 0, nor does it reliably own arbitrary descendants after reparenting/session changes.

Observed contradictions:

- Tightening static checks catches more hidden attempts, but creates compatibility false positives for legal foreground child processes.
- Loosening static checks preserves legal workspace writes, but allows hidden-denial evidence to surface as success when stderr/exit status are suppressed.
- PPID/process-group sampling can catch simple leaks, but not every double-fork, session split, or interpreter-mediated process lifecycle escape.
- Over-budget command analysis cannot simultaneously avoid static interpretation and guarantee complete attempted-mutation evidence.

## Strategy Options

### Option A -- revise #19 boundary to observable authority

Recommended strategy.

Update the #19/OpenSpec acceptance boundary so M1 guarantees:

- raw bytes under `data/raw/**` cannot be mutated by bash invocations;
- audit/remediation evidence is produced for statically observed advisory denials and OS-denial failures visible through the process result;
- audit storage and known evidence namespaces remain protected from child writes;
- hardlink leakage is covered by `nlink` scanning plus DataProvenance checksum policy;
- arbitrary hidden/suppressed denied attempts and arbitrary descendant lifecycle ownership are explicitly moved out of #19 and into a later executor/runtime containment decision.

This preserves the 2026-07-04 ADR-0001 decision that the OS sandbox is authority for raw-byte protection, while avoiding a false promise that M1 can provide omniscient attempted-write telemetry or process-tree ownership with the current executor primitive.

Required follow-up if selected:

- Amend the policy-gate-spike spec scenarios and design Decision 13 to separate byte-protection authority from attempted-denial telemetry.
- Add an ADR-0001 note that hidden/suppressed OS-denial telemetry and arbitrary process-tree lifecycle ownership require a stronger executor/audit backend.
- Close or re-scope the confirmed P1 findings as acceptance-boundary corrections, not implementation misses.
- Re-run the #19 tests and Phase 7 against the revised boundary.

### Option B -- redesign the executor inside #19

Possible but high-risk.

Replace the current bash wrapper contract with a stronger execution primitive that can own process lifecycle and denial telemetry. Candidate directions include a dedicated process supervisor, stricter interpreter restrictions, an OS audit/event source, or a RunJob-backed executor that can defer terminal results until containment is proven.

This is likely larger than #19 and may collide with M1 compatibility requirements because ordinary bash workflows rely on foreground subprocesses. It also risks duplicating later RunJob/executor work.

### Option C -- continue static/preflight patching

Rejected for this gate.

The `4717f16` review confirms the same invariant family after the allowed corrective round. Continuing with another regex/static-analysis patch would violate the prior post-gate strategy and the ADR premise that shell semantics cannot be made authoritative by pre-exec parsing.

## Gate Decision

Ordinary fix-forward is stopped.

PR #48 needs an explicit scope decision before more implementation work:

- choose Option A to revise the #19 acceptance boundary around observable authority and move non-observable telemetry/lifecycle guarantees out of M1; or
- choose Option B to redesign the executor now and accept the larger scope/risk.

Until that decision is recorded, PR #48 remains blocked and unmergeable.
