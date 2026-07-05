# Follow-up Final Review - invariant-state - 90c4c39

Reviewer agent: review-invariant-state
Review round: follow-up final after e4f00c3 fixes
Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`

Summary: e4f00c3 fixes are mostly closed, but two candidate state/invariant gaps remain around mutable root identity and Python `Popen` wait recognition.

## Invariant Matrix Coverage

- Raw byte invariant: missing - stable-config seatbelt coverage is present, but constructed tools keep caller-owned root arrays mutable until run time; see Finding 1.
- Evidence identity includes guard/profile id, `ErrorRecord.remediation`, `tool.failed`, and audit path: covered.
- Six escape classes byte-blocked: covered under stable configuration; mutable protected-root identity remains a separate gap.
- Legal raw read allowed: covered.
- Workspace writes allowed: covered.
- Waited foreground child allowed: covered.
- Simple un-awaited Python `Popen` rejected: covered for the direct case; residual textual false-wait gap in Finding 2.
- Pre-existing hardlink residual demonstrated and bounded `nlink>1` scan detects: covered.
- Obvious advisory raw write may pre-deny with remediation/audit/WS: covered.
- Hidden denial / post-exec sandbox attribution not claimed: covered.
- Stale protected raw root finalizes running state: covered.
- WS/fuse caller mutation snapshots: covered for WS error payloads and fuse rules.
- `zero` diff stays 0 and pinned: covered.

## Findings

- Severity: P1
  Failure class: state identity / mutable configuration aliasing
  Violated invariant/contract: Protected raw root identity must be bound when the SHUD bash wrapper is constructed; caller mutation after construction must not change which raw bytes the seatbelt profile protects.
  Concrete scenario: Code constructs `RawDataSandboxedBashTool` or `createShudSandboxedBashTool()` with `protectedRawPaths = [realRawRoot]`, then mutates that same array to an existing sibling root before the command runs. At execution, the profile/advisory/audit use the mutated root, while `allowedWriteRoots` can still allow the project root, so `printf MUTATED > data/raw/input.csv` can modify the originally intended raw bytes.
  Evidence: `RawDataSandboxedBashTool` snapshots only `fuseRules` while retaining other option arrays; `resolveRawDataSandboxRuntimeRoots()` reads `options.protectedRawPaths` at run time; `createShudSandboxedBashTool()` passes caller root arrays through.
  Consequence: The core raw-data byte-protection invariant can collapse through stale or mutated shared config, and profile/audit identity would bind to the wrong root.
  Fix direction: Snapshot all root arrays at construction/factory boundaries: `protectedRawPaths`, `allowedWriteRoots`, and `protectedEvidencePaths`; consider freezing internal option snapshots and cloning in `createRawDataWriteAdvisoryRule` for consistency.
  Required verification: Add direct constructor and registry tests that mutate `protectedRawPaths` after construction to a sibling existing path, then verify an original `data/raw` write is still denied/byte-blocked and profile/audit identity uses the original root.
  Sibling surfaces: `RawDataSandboxedBashTool`, `createShudSandboxedBashTool`, `createShudRuntimeToolRegistry`, `createRawDataWriteAdvisoryRule`, protected evidence path handling.
  Blocking status: Blocking for raw byte authority.

- Severity: P2
  Failure class: state-machine / process lifecycle false negative
  Violated invariant/contract: A command should not be reported as allowed when a statically detectable un-awaited Python `Popen` child can continue mutating workspace after wrapper terminal state.
  Concrete scenario: `python3 -c 'import subprocess; p=subprocess.Popen(["sh","-c","sleep .25; printf late > workspace/late.txt"]); if False: p.wait(); print("ok")'` contains a later textual `p.wait()` but never waits at runtime. The preflight treats it as waited, so the command can finish and audit `allowed` before the child writes.
  Evidence: Python process preflight accepts any later `p.wait()` / `p.communicate()` text in `afterCall` without top-level/control-flow validation.
  Consequence: The simple e4f00c3 un-awaited `Popen` regression is closed, but a nearby state-machine bypass can still create stale `allowed` lifecycle evidence for post-completion workspace mutation.
  Fix direction: Treat assignment-form `Popen` as waited only for an immediate same top-level wait/communicate before control-flow/function boundaries, or conservatively deny ambiguous cases while preserving `Popen(...).wait()` and straight-line `p.wait()` positives.
  Required verification: Add regressions for `if False: p.wait()` and `def later(): p.wait()` remaining rejected, plus positive tests for immediate chained and straight-line waited foreground children.
  Sibling surfaces: Python process preflight helper, shell background wait parser, any future Node/R/Ruby wait heuristics.
  Blocking status: Not blocking raw byte authority; blocking if this PR claims the un-awaited-Popen lifecycle gap is fully closed.

## Non-blocking Notes

- Prior e4f00c3 findings status: ambient env secrets closed in this reviewer's main classification; simple un-awaited `Popen` closed for the direct case; stale protected raw root finalization closed; generic WS error snapshot closed; fuse rule object mutation closed.
