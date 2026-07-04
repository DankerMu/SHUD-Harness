Reviewer agent: review-test-evidence
Review round: post-gate follow-up on 4717f16
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a
Summary: Most cand-2689 follow-up evidence is now covered, but hidden over-budget raw writes can still be recorded as allowed, and process-containment positives miss waited child-process workspace writes.

Invariant Matrix Coverage:
- task 3.3: missing - raw sandbox/profile/registry/WS surfaces are covered, but Finding 1 leaves a raw-write attempt returning `tool.completed` / `allowed`.
- four spec scenarios: missing - six escape denials covered at `packages/core/src/tools/raw-data-sandbox.test.ts:78`; hardlink residual and bounded scan covered at `:2478` and `:2612`; advisory/WS/audit/profile identity covered at `:1800`, `:2865`, and `packages/backend/src/ws/index.test.ts:14`; legal workspace-write compatibility is still incomplete per Finding 2.
- prior candidate closures: missing - cand-2689-02 and direct cand-2689-04 cases are covered; cand-2689-03 is only covered for call-cap/`chr` variants, not budget-exceeded hidden writes; cand-2689-04 lacks an actual waited child-process positive boundary.
- local verification: covered - checked HEAD, `git diff --check main...HEAD`, `zero` clean/head; targeted temp-dir repros confirmed Findings 1-2. Full suite not rerun by reviewer; using orchestrator evidence.
- zero: covered - `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`, diff clean.

Findings:
- severity: P1
  failure class: hidden-denial evidence / test-evidence gap / false success
  violated invariant/contract: attempted `data/raw/**` mutations denied by the OS sandbox must surface as failed ToolResult plus `tool.failed`/audit evidence, not `tool.completed`/`allowed`.
  concrete scenario: `printf x > data/raw/over-budget-shell.txt 2>/dev/null || true # <140k filler>` exceeds command-analysis budget, the seatbelt denies the write, shell status is normalized to success, and the wrapper appends an allowed completion row.
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:47`, `:674`, `:640`, `:3789`, `:453`; missing negative around `packages/core/src/tools/raw-data-sandbox.test.ts:2669`.
  consequence: cand-2689-03 is not fully closed; raw bytes remain protected, but result/audit evidence falsely says the invocation succeeded.
  fix direction: keep legal over-budget read/write fail-open, but add a bounded raw-mutation/suppression signal for budget-exceeded commands or post-exec normalize successful commands with visible sandbox denial and a proven raw-write target.
  required test/proof: add over-budget suppressed shell raw-write and over-budget interpreter-payload catch tests; assert failed result, `tool.failed`, non-`allowed` audit, and raw unchanged; keep current legal over-budget positives.
  sibling surfaces: command-length budget, interpreter-payload budget, segment budget, stderr/exit masking, advisory-disabled wrapper path, registry wrapped bash path.
  blocking status: Blocking for final test-evidence sign-off.
- severity: P2
  failure class: compatibility / false-positive boundary coverage
  violated invariant/contract: legal workspace writes must remain allowed; process containment should reject escaping/unwaited descendants, not ordinary foreground child processes that are waited before exit.
  concrete scenario: `python3 -c 'import subprocess, sys; p=subprocess.Popen(["sh","-c","printf ok > workspace/popen-wait.txt"]); sys.exit(p.wait())'` is rejected as `policy_gate_process_containment_unavailable`.
  evidence (file:line): preflight deny path at `packages/core/src/tools/raw-data-sandbox.ts:395`; broad Python matcher at `:3587`; tests cover detached negatives at `packages/core/src/tools/raw-data-sandbox.test.ts:1613` and keyword text positives at `:1683`, but not waited child-process positives.
  consequence: valid workspace workflows using foreground subprocesses can be blocked, which weakens the legal workspace-write evidence boundary.
  fix direction: distinguish detached/unwaited/session-changing process creation from waited foreground subprocess use, or explicitly scope process-backed workspace writes out in OpenSpec.
  required test/proof: add positive waited-child workspace-write tests with audit `allowed`, file exists, and no post-return side effects; keep detached/session escape negatives.
  sibling surfaces: Python `Popen(...).wait()/communicate`, Node child_process foreground patterns, Ruby fork/spawn wait, R `system(wait=TRUE)`, future RunJob execution.
  blocking status: Blocking unless this compatibility loss is explicitly accepted as a scoped non-goal.

Non-blocking notes:
- None.
