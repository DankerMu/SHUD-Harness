# Candidate findings — PR #48 post-gate follow-up 2689f1f

Reviewed head SHA: `2689f1f9bb82b23a86acd51418e40f8fafba3d04`

Source reports:
- `.workplans/issue-19/review/followup-post-gate-2689f1f-correctness.md`
- `.workplans/issue-19/review/followup-post-gate-2689f1f-integration.md`
- `.workplans/issue-19/review/followup-post-gate-2689f1f-security-perf.md`
- `.workplans/issue-19/review/followup-post-gate-2689f1f-test-evidence.md`
- `.workplans/issue-19/review/followup-post-gate-2689f1f-spec-compliance.md`
- `.workplans/issue-19/review/followup-post-gate-2689f1f-invariant-state.md`

## cand-2689-01 — process lifecycle escape / audit durability

Originating reviewers: correctness, integration, security-perf, invariant-state.
Severity: P1.
Failure class: process lifecycle containment / audit evidence durability.
Invariant: a bash invocation must not leave invocation-owned descendants able to mutate workspace or audit state after the tool reaches a terminal result.
Scenario family: programmatic detached/session children can avoid literal `setsid|setpgrp|start_new_session` preflight and PPID sampling, then write workspace files or move `workspace/tasks` after the wrapper returns `tool.completed`.
Representative evidence: `raw-data-sandbox.ts` process preflight around `3283`, top-level wait around `1146`, descendant sampling around `1535`/`1647`, allowed audit append around `424`; security-perf reported a targeted `subprocess.Popen(..., **{"start"+"_new_session": true})` probe.

## cand-2689-02 — over-budget legal command false denial / wrong evidence label

Originating reviewers: correctness, test-evidence, spec-compliance, invariant-state.
Severity: P1/P2.
Failure class: compatibility / spec-compliance / test-evidence.
Invariant: pre-exec analysis is advisory/fail-open and must not reject legal raw reads or workspace writes merely because command semantics are uncertain; static uncertainty must not be reported as `denied_by_sandbox`.
Scenario family: a legal oversized command such as `cat data/raw/input.csv # <large filler>` or `printf ok > workspace/out.txt 2>/dev/null; true # <large filler>` exceeds command-analysis budget; analysis marks hidden evidence risk and returns `raw_data_write_denied` before sandbox execution.
Representative evidence: `raw-data-sandbox.ts` around `605`-`616`, `640`-`654`, `332`; existing test around `raw-data-sandbox.test.ts:2434` locks in fail-closed for an over-budget workspace-only command.

## cand-2689-03 — hidden raw-write false success when target recognition misses the attempt

Originating reviewers: integration, invariant-state.
Severity: P1.
Failure class: hidden-denial evidence / evidence-state false success.
Invariant: any attempted `data/raw/**` mutation denied by the OS sandbox must surface as a failed tool result plus `tool.failed`/audit evidence, not as `allowed`.
Scenario family: an interpreter payload performs many benign write-capable calls before a swallowed raw write after the 512 call cap, or builds `data/raw` via obfuscated expressions such as `chr(100)+"ata/raw/hidden.txt"`. Raw bytes are protected, but static recognition misses the target and post-exec classification can record `tool.completed`.
Representative evidence: call cap constants around `raw-data-sandbox.ts:50`, analysis around `605`/`677`, target recognition around `2513`/`2643`, post-exec denial classification around `3397`/`3398`.

## cand-2689-04 — containment keyword false positive for legal workspace writes

Originating reviewers: test-evidence.
Severity: P2.
Failure class: compatibility / false-positive coverage.
Invariant: process containment preflight must not reject legal workspace writes just because containment keywords appear as data, comments, or filenames.
Scenario family: `printf setsid > workspace/setsid.txt` or `printf daemonize > workspace/note.txt` is a legal workspace write but broad `hasSessionEscapeSignal()` over the raw command string returns `policy_gate_process_containment_unavailable`.
Representative evidence: `raw-data-sandbox.ts` around `3283`-`3307`; legal workspace write tests around `raw-data-sandbox.test.ts:1192`-`1205` do not cover keyword boundaries.
