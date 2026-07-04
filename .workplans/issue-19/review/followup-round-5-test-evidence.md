# PR #48 round 5 review - test evidence

Reviewer agent: review-test-evidence
Review round: round 5 comprehensive convergence check
Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Summary: Most R4 regressions now have durable tests, but audit evidence can still be lost after bash execution, and truncation/overwrite of existing raw bytes is not directly covered.

Invariant Matrix Coverage:
- Governing invariant: missing - create/delete/rename/read/write-positive paths are covered, but direct truncation/overwrite of an existing raw file is not proven; see Finding 2.
- Source-of-truth identity/contract: missing - remediation/profile/tool.failed/audit fields are broadly asserted, but mandatory audit append can still be silently lost; see Finding 1.
- Producers: covered - sandbox/profile helper, wrapper, advisory rule, audit helper, registry factory, and WS builder are present and exported.
- Validators/preflight: covered - profile/advisory/nlink/sandbox execution tests are present, with one truncation boundary gap noted below.
- Storage/cache/query: missing - audit reservation validates symlink/hardlink shape but not appendability before the sandboxed command runs; see Finding 1.
- Public routes/entrypoints: covered - M1 has no full route; registry tests cover the SHUD runtime registry factory and wrapped bash/spawn/edit surfaces.
- Frontend/downstream consumers: out-of-scope - full AgentActivityFeed/full WS bus is explicitly deferred; skeleton `tool.failed` shape is tested.
- Failure paths/rollback/stale state: missing - symlink/hardlink stale audit states are covered, but regular unwritable audit targets can still drop evidence after command execution.
- Evidence/audit/readiness: missing - hardlink residual evidence is covered; audit durability still has the appendability gap.
- Six escape classes: covered - interpreter, pipeline/stdin, dynamic target, child/grandchild, symlink/`../`, rename/unlink tests assert no raw mutation plus denial/audit profile id.
- Legal raw read/workspace write: covered - raw read, raw read with denial-like output, raw-to-workspace copy, and workspace write are allowed under the profile.
- Pre-existing hardlink residual: covered - test demonstrates mutation through a pre-existing alias and bounded `nlink>1` scan of explicit protected roots.
- Advisory behavior: covered - obvious static writes deny with remediation; uncertain dynamic write and legal raw reads fail open to sandbox authority.
- Zero clean: covered - `git diff --check origin/main...HEAD` had no output; `git -C zero diff --quiet` exited 0 and `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- Candidate finding 1: audit appendability is not reserved before bash execution.
  Severity: P1
  Failure class: data-integrity
  Violated contract/invariant: `policy-gate-spike` requires each raw-write denial and each profiled bash audit row to persist under `workspace/tasks/TASK-M1-SPIKE/audit/` with profile identity; stale audit state must fail closed before bash if mandatory evidence cannot be recorded.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:271` reserves only path shape before execution; `packages/core/src/tools/raw-data-sandbox.ts:326` runs bash; `packages/core/src/tools/raw-data-sandbox.ts:344` appends denial audit after execution; `packages/core/src/tools/raw-data-sandbox.ts:372` suppresses append errors; `packages/core/src/tools/raw-data-sandbox.ts:1736` / `:1813` validate symlink/hardlink shape but not writability.
  Concrete scenario: pre-create `workspace/tasks/TASK-M1-SPIKE/audit/policy-gate.ndjson` as a regular single-link file without write permission, then run a sandbox-denied raw write such as `d=data; r=raw; p="$d/$r/no-audit.txt"; printf x > "$p"` with advisory disabled. Reservation passes, bash executes, sandbox denies raw mutation, append fails with `EACCES`, and the wrapper returns a denial payload without a durable audit row.
  Consequence: a prior verified R4 audit-durability class remains open for regular stale permission state; raw bytes stay protected, but evidence lineage and mandatory audit replay can be lost after side effects outside raw have already occurred.
  Fix direction: make reservation prove appendability before any bash execution, for example by opening/creating the final audit file with `O_APPEND|O_WRONLY|O_CREAT|O_NOFOLLOW` and `fstat` during reservation, or by holding a safe append handle/fallback. If that cannot be proven, return `policy_gate_audit_unavailable` before running bash; do not silently continue on mandatory denial-audit append failure without durable fallback.
  Required verification: add wrapper-level tests for an unwritable regular audit file and/or unwritable audit directory that assert no bash side effects occur and no raw mutation occurs; add a direct `appendPolicyGateAuditRow` test for the same stale state. Rerun focused raw sandbox tests and root `bun run check`.
  Sibling surfaces to audit: `appendAudit` for allowed calls, public `appendPolicyGateAuditRow`, disk-full/quota errors, concurrent external replacement between reservation and append, and custom `auditWorkspaceRoot` permission state.
  Blocking status: Blocking candidate; this is the same evidence-durability invariant that prior rounds required to fail-close.
- Candidate finding 2: existing-file truncation/overwrite is not directly proven by the regression suite.
  Severity: P2
  Failure class: test-evidence
  Violated contract/invariant: `openspec/changes/m1-foundation/design.md:168` says protected raw bytes must not be created, modified, deleted, renamed, or truncated; `design.md:188` includes truncation in the write/delete/overwrite surface.
  Evidence: the six negative cases in `packages/core/src/tools/raw-data-sandbox.test.ts:65` cover new-file writes, symlink/`../`, rename, and unlink; advisory coverage at `packages/core/src/tools/raw-data-sandbox.test.ts:422` checks `dd`, `mkdir`, and `chmod`, but no seatbelt execution test disables advisory and attempts `: > data/raw/input.csv`, `truncate -s 0 data/raw/input.csv`, append, or overwrite of a pre-existing raw file while asserting original contents remain unchanged.
  Concrete scenario: a regression in the seatbelt profile or wrapper classification could still block raw file creation and unlink but allow truncation of `data/raw/input.csv`; the current tests would not fail because they mostly assert missing new targets or preserved file only for `rm`.
  Consequence: the most destructive overwrite/truncate class can escape test evidence even though it is named in the governing invariant.
  Fix direction: add at least one macOS `seatbeltTest` with `enableAdvisory:false` that pre-populates a raw file, attempts shell redirection truncation and/or `truncate -s 0`, expects `denied_by_sandbox`, asserts remediation/audit profile id, and verifies the original raw file content is byte-for-byte unchanged.
  Required verification: rerun `packages/core/src/tools/raw-data-sandbox.test.ts` on macOS/seatbelt plus root `bun run check`.
  Sibling surfaces to audit: append `>>`, `cp` over existing raw destination, `dd of=data/raw/input.csv`, metadata mutation commands (`chmod`, `xattr`) under sandbox authority, and hardlink residual tests to keep that exception explicit.
  Blocking status: Non-blocking P2 candidate, but should be fixed or explicitly deferred before final evidence sign-off.

Non-blocking notes:
- The R4 masked-denial, interpreter-swallow, registry wrapping, protected evidence path, legal raw-read false-positive, WS remediation, and hardlink residual concerns are now represented by focused regression tests.
- I did not rerun Bun/OpenSpec tests in this read-only review; I relied on the provided local verification for those and independently checked `git diff --check` plus zero submodule cleanliness.
