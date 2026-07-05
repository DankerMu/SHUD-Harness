# Candidate findings -- PR #48 observable 215d635

Reviewed head SHA: `215d635e8edc6c4e5db3af8b833cf377fdda02cc`

Source reports:
- `.workplans/issue-19/review/followup-observable-215d635-correctness.md`
- `.workplans/issue-19/review/followup-observable-215d635-integration.md`
- `.workplans/issue-19/review/followup-observable-215d635-security-perf.md`
- `.workplans/issue-19/review/followup-observable-215d635-test-evidence.md`
- `.workplans/issue-19/review/followup-observable-215d635-spec-compliance.md`
- `.workplans/issue-19/review/followup-observable-215d635-invariant-state.md`

## cand-observable-215-01 -- target-qualified forged or unrelated denial text can become false raw sandbox denial

Originating reviewers: correctness, security-perf, test-evidence, spec-compliance, invariant-state.
Severity: P1.
Failure class: evidence/audit false positive / observable-denial attribution.
Claim: `lineMentionsTarget()` accepts raw path variants and basename-only target matches, so a non-executed or suppressed raw write plus user-controlled / unrelated `Permission denied` text that names the same target or basename can still be promoted to `raw_data_write_denied` and audit `decision=denied_by_sandbox`.
Blocking input: yes.

## cand-observable-215-02 -- outer raw deny can still collapse sibling root identity when inner raw text is present

Originating reviewer: invariant-state.
Severity: P1.
Failure class: evidence/audit identity collapse across sibling protected roots.
Claim: a mismatched outer raw advisory deny can include an additional inner `data/raw` dead-branch/static target. Since `PolicyGateDecision` carries only `ruleId` and `canAttributeOuterRawPolicyGateDeny()` re-runs inner advisory on command text, the adapter can emit `raw_data_write_denied` with the sandbox profile for the inner protected root even though the outer deny was caused by a sibling root.
Blocking input: yes.
