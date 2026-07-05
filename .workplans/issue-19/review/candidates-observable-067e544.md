# Candidate findings -- PR #48 observable 067e544

Reviewed head SHA: `067e544368f88ec60922a243f1bcf6597f211489`

Source reports:
- `.workplans/issue-19/review/followup-observable-067e544-correctness.md`
- `.workplans/issue-19/review/followup-observable-067e544-integration.md`
- `.workplans/issue-19/review/followup-observable-067e544-security-perf.md`
- `.workplans/issue-19/review/followup-observable-067e544-test-evidence.md`
- `.workplans/issue-19/review/followup-observable-067e544-spec-compliance.md`
- `.workplans/issue-19/review/followup-observable-067e544-invariant-state.md`

## cand-observable-067-01 -- symlinked raw mutation commands can lose visible denial evidence

Originating reviewers: correctness, invariant-state.
Severity: P1.
Failure class: observable-denial evidence / symlink alias classification.
Claim: post-exec symlink target resolution covers redirection and selected copy/write forms but omits mutation commands such as `mv`, `rm`, `unlink`, `mkdir`, and `ln`, so a visible seatbelt denial through `workspace/raw-link -> ../data/raw` can fall through as generic `failed` instead of `raw_data_write_denied`.
Blocking input: yes.

## cand-observable-067-02 -- denial-like user output can become false raw sandbox denial

Originating reviewers: security-perf, correctness, invariant-state.
Severity: P1.
Failure class: evidence/audit false positive / output-only denial classification.
Claim: post-exec classification can promote generic `Permission denied` or `sandbox` text plus a syntactic raw target signal into `raw_data_write_denied`, even when the raw write branch did not execute or the real denial was hidden/suppressed.
Blocking input: yes.

## cand-observable-067-03 -- over-budget visible raw write denial can be downgraded to generic failure

Originating reviewer: integration.
Severity: P1.
Failure class: observable-denial evidence / bounded analysis fallback.
Claim: when command analysis exceeds `COMMAND_ANALYSIS_MAX_LENGTH`, the classifier can return false before checking visible denial output or a bounded raw target prefix, so an actually visible seatbelt denial of `data/raw/over-budget-visible.txt` can be audited as generic `failed`.
Blocking input: yes.

## cand-observable-067-04 -- outer raw policy denial can emit unrelated sandbox profile identity

Originating reviewer: integration.
Severity: P2.
Failure class: ToolResult/audit/WS identity and profile provenance coherence.
Claim: a registry configured with sandbox protected roots that differ from the outer `raw-data-write` advisory roots can deny by the outer rule without executing bash, yet `denyByOuterRawPolicyGate()` can emit a `profile_id` computed from the unrelated sandbox protected roots.
Blocking input: no by severity, but verify for fix/defer decision because it touches audit evidence identity.
