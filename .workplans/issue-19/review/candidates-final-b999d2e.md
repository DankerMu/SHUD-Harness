# Candidate Findings - final follow-up b999d2e

Reviewed head SHA: `b999d2e6e03af4424620cd2077688c2fd322aa93`

## Deduplicated Candidates

- `cand-final-b999d2e-01-ci-ruby-move-oracle`
  - Origin: test/evidence / security-performance / spec-compliance / invariant-state / integration
  - Severity: P1
  - Claim: GitHub `macos-seatbelt` and aggregate `check` are red because the Ruby raw-source move test expects no workspace target, while the runner creates a workspace copy and preserves the raw source.
- `cand-final-b999d2e-02-policy-evaluator-exception-lifecycle`
  - Origin: integration
  - Severity: P1
  - Claim: policy evaluator exceptions or invalid remediation reject from `PolicyGatedBaseToolAdapter.run()` instead of returning a failed `ToolResult`, bypassing Zero lifecycle and running-handle completion.

## Clean Review Inputs

- correctness: CLEAN
