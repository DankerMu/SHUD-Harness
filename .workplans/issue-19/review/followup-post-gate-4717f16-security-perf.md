Reviewer agent: review-security-perf
Review round: post-gate follow-up on 4717f16
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a
Summary: Two P1 candidates remain: escaped subprocesses can write after a successful return, and over-budget hidden raw-write denials can be audited as allowed.

Invariant Matrix Coverage:
- raw byte safety: covered - canonical `data/raw/**` write denial is in the seatbelt profile at `packages/core/src/tools/raw-data-sandbox.ts:217`, with negative path tests at `packages/core/src/tools/raw-data-sandbox.test.ts:78`.
- process containment: missing - child-shell and here-doc process creation can escape the current containment checks; see Finding 1.
- audit durability: missing - over-budget hidden sandbox denials can append `decision=allowed`; see Finding 2.
- bounded analysis: missing - command analysis has a length budget at `packages/core/src/tools/raw-data-sandbox.ts:714`, but the over-budget path does not fail closed for swallowed sandbox denials.
- compatibility: covered - legal raw reads/workspace writes are tested at `packages/core/src/tools/raw-data-sandbox.test.ts:914`, `packages/core/src/tools/raw-data-sandbox.test.ts:1258`, and `packages/core/src/tools/raw-data-sandbox.test.ts:2669`.

Findings:
- severity: P1
  failure class: process containment bypass / post-return side effect
  violated invariant/contract: Bash commands must not leave untracked descendants mutating workspace after the tool has returned terminal success.
  concrete scenario: `bash -c 'sleep 0.25; printf leaked > workspace/child-shell-bg-leak.txt &'` returns `success: true`; 500 ms later the child writes `workspace/child-shell-bg-leak.txt`. A Python here-doc variant using `subprocess.Popen(..., start_new_session=True)` also returned success and wrote after return.
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:3480` only checks top-level session/background signals before execution; `packages/core/src/tools/raw-data-sandbox.ts:3696` checks unquoted `&` in the outer command text and ignores quoted `bash -c` payloads/here-doc interpreter bodies.
  consequence: callers can observe a completed successful tool call while process side effects are still happening, which breaks lifecycle evidence and can corrupt allowed workspace outputs outside the audited command window.
  fix direction: recursively analyze `sh|bash -c` payloads and here-doc/stdin interpreter bodies for background/session/process-creation forms, or fail closed on child-shell/interpreter payloads that cannot be bounded; add runtime containment proof that does not depend on catching very short-lived parents in the PPID tree.
  required test/proof: add regression tests for `bash -c 'sleep ... &'`, `sh -c '... &'`, and `python3 - <<'PY' subprocess.Popen(... start_new_session=True)` asserting `policy_gate_process_containment_unavailable` or no post-return write after a wait.
  sibling surfaces: `node <<EOF`, `ruby <<EOF`, `Rscript` stdin, nested `env bash -c`, and top-level `wait` appearing before a later background job.
  blocking status: Blocking candidate.
- severity: P1
  failure class: false success / corrupt audit decision for swallowed OS denial
  violated invariant/contract: A sandbox-denied raw-data write must not be reported or audited as an allowed successful command, including when command analysis is over budget.
  concrete scenario: `node -e 'require("fs").writeFileSync("data/raw/overbudget-node-hidden.txt","x")' 2>/dev/null || true # <140k filler>` is over the analysis length budget. Seatbelt blocks the raw write, raw bytes remain absent, but the tool returns `success: true` and appends audit `decision:"allowed"`.
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:674` short-circuits over-budget analysis; `packages/core/src/tools/raw-data-sandbox.ts:3789` only maps over-budget sandbox denials when `!result.success`, so exit-code normalization bypasses denial evidence.
  consequence: PI/audit consumers see an allowed successful bash call even though the command attempted a prohibited raw mutation and was blocked by the OS sandbox.
  fix direction: fail closed for over-budget commands that contain raw-path/write-capable signals plus denial-hiding patterns, and classify sandbox-denial output as denial even when exit status is normalized; where the command is too large to prove safe, return remediation instead of `allowed`.
  required test/proof: add over-budget hidden raw-write tests for shell redirection and interpreter writes with `2>/dev/null || true`, asserting `raw_data_write_denied`, `decision=denied_by_advisory|denied_by_sandbox`, and no `allowed` audit row.
  sibling surfaces: long commands with `; true`, `|| :`, `exit 0`, stderr redirection to workspace files, and long generated interpreter payloads.
  blocking status: Blocking candidate.

Non-blocking notes:
- The audit handle reservation plus seatbelt-protected evidence namespace is a good pattern; the remaining gaps are around lifecycle classification, not the basic profile construction.

Execution Summary: agents=review-security-perf; skills=review; tools=git/gh/rg/sed/nl/pnpm-bun ad hoc repros; verification=diff+OpenSpec/ADR/issue read, 2 local temp-dir reproductions; limits=read-only, report target not written.
