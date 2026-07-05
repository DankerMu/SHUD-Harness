# Candidate findings -- PR #48 observable 37cd38e

Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Source reports:
- `.workplans/issue-19/review/followup-observable-37cd38e-correctness.md`
- `.workplans/issue-19/review/followup-observable-37cd38e-integration.md`
- `.workplans/issue-19/review/followup-observable-37cd38e-security-perf.md`
- `.workplans/issue-19/review/followup-observable-37cd38e-test-evidence.md`
- `.workplans/issue-19/review/followup-observable-37cd38e-spec-compliance.md`
- `.workplans/issue-19/review/followup-observable-37cd38e-invariant-state.md`
- `.workplans/issue-19/review/ci-failure-observable-37cd38e.md`

## cand-observable-37-01 -- visible symlink-only raw alias denial may be generic failure

Originating reviewer: correctness.
Severity: P1.
Failure class: observable-denial evidence / path-safety.
Claim: a visible write through `workspace/link-to-raw -> data/raw/...` has no lexical `data/raw` target, so post-exec classification may emit generic failure instead of `raw_data_write_denied`.
Blocking input: yes.

## cand-observable-37-02 -- outer raw policy deny can be delegated back into inner sandbox

Originating reviewer: correctness.
Severity: P1.
Failure class: wrapper / policy-gate deny bypass.
Claim: `policy-gate-registry` delegates outer `raw-data-write` deny to `innerTool.run()`, so stale/mismatched inner sandbox roots or disabled advisory can execute after an explicit deny.
Blocking input: yes.

## cand-observable-37-03 -- over-budget analysis can false-classify unrelated Permission denied as raw denial

Originating reviewers: integration, security-perf.
Severity: P1.
Failure class: evidence/audit contract / resource bounded analysis.
Claim: over-budget command analysis can classify from denial output alone, causing raw-read or unrelated workspace permission failures to become `raw_data_write_denied`.
Blocking input: yes.

## cand-observable-37-04 -- visible exit-normalized raw denial recorded as allowed

Originating reviewer: invariant-state.
Severity: P1.
Failure class: evidence/audit state classification.
Claim: captured sandbox denial text plus `|| true`/`; true` can exit 0 and be recorded as `tool.completed`/`allowed`, even when command analysis identifies a raw write target.
Blocking input: yes.

## cand-observable-37-05 -- unavailable seatbelt/interpreter tests fail instead of skipping

Originating reviewer: test-evidence, corroborated by CI.
Severity: P2.
Failure class: test-evidence / CI portability.
Claim: several real sandbox runtime tests are plain `test(...)`, so Linux/non-seatbelt CI fails instead of skipping.
Blocking input: yes because CI is failing and evidence gate requires required checks pass.

## cand-observable-37-06 -- `innerTool` option drops wrapped BashTool fuse/lifecycle semantics

Originating reviewer: integration.
Severity: P2.
Failure class: wrapper/proxy faithfulness.
Claim: `RawDataSandboxedBashTool` accepts `innerTool`, but uses it only as metadata and runs sandboxed bash directly, dropping inner fuses/custom behavior.
Blocking input: no by reviewer severity, but verify for fix/defer decision.

## cand-observable-37-07 -- runtime resource bounds: frequent `ps` polling and unbounded output buffering

Originating reviewer: security-perf.
Severity: P2.
Failure class: resource/performance.
Claim: long commands can trigger `/bin/ps` sampling every 20ms and unbounded stdout/stderr buffering.
Blocking input: no by reviewer severity, but verify for fix/defer decision.

## cand-observable-37-08 -- process preflight scans outside command-analysis budget

Originating reviewer: invariant-state.
Severity: P2.
Failure class: resource limit / preflight boundedness.
Claim: process-containment preflight scans full command/interpreter payload outside the existing command/payload budgets.
Blocking input: no by reviewer severity, but verify for fix/defer decision.
