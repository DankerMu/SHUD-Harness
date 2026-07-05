# Candidate Findings - final follow-up 1293927

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`

## Deduplicated Candidates

- `cand-final-1293927-01-ci-skips-seatbelt-authority`
  - Origin: test/evidence
  - Severity: P1
  - Claim: required GitHub `check` runs only on Ubuntu and skips all macOS seatbelt authority tests, so CI can pass without executing #19 core acceptance evidence.
- `cand-final-1293927-02-afterexecute-terminal-metadata`
  - Origin: correctness
  - Severity: P2
  - Claim: `RawDataSandboxedBashTool` finalizes running metadata before Zero `afterExecute()`; if `afterExecute()` throws, final `ToolResult` and terminal metadata can diverge.
- `cand-final-1293927-03-policy-deny-secret-redaction`
  - Origin: integration
  - Severity: P1
  - Claim: policy-gate deny results bypass Zero `afterExecute()` and therefore skip `secretFilter` redaction.

## Clean Review Inputs

- spec-compliance: CLEAN
- security/performance: CLEAN
- invariant/state: CLEAN
