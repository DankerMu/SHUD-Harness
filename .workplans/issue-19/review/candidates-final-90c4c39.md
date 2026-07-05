# Candidate Findings - final follow-up 90c4c39

Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`

Deduped candidates for Phase 4.5 verifier pass:

## cand-final-90c4c39-01-mutable-root-arrays

Origin: review-correctness, review-invariant-state
Severity: P1
Failure class: state identity / mutable configuration aliasing
Claim: `RawDataSandboxedBashTool` and registry factory snapshot `fuseRules` but retain caller-owned root arrays (`protectedRawPaths`, `allowedWriteRoots`, `protectedEvidencePaths`) by reference. Mutating those arrays after construction but before `run()` can change which root the seatbelt profile protects and thereby disable the original raw byte authority.

## cand-final-90c4c39-02-fake-wait-popen

Origin: review-test-evidence, review-security-perf, review-correctness, review-invariant-state
Severity: P1
Failure class: process lifecycle / false waited-child proof
Claim: Python `Popen` assignment forms are treated as waited when any later lexical `p.wait()`/`p.communicate()` exists, even when unreachable (`if False`, after `sys.exit`, inside function). This can allow normal completion/audit while a delayed child continues writing workspace.

## cand-final-90c4c39-03-lc-env-leak

Origin: review-spec-compliance, review-test-evidence, review-security-perf, review-correctness
Severity: P1
Failure class: information disclosure / sandbox environment boundary
Claim: `isLocaleEnvName()` accepts any `LC_[A-Z_]+`, so host variables like `LC_API_KEY` or `LC_PASSWORD` are inherited into sandboxed bash without explicit `envSecrets` registration/redaction.

## cand-final-90c4c39-04-preexecute-terminal-metadata

Origin: review-correctness
Severity: P2
Failure class: state-transition / pre-execute terminal metadata gap
Claim: `RawDataSandboxedBashTool.fuseCheck()` can throw before `execute()`, while `finalizeToolResult()` only runs inside `execute()`. A fuse-denied command can return a failed tool result but leave a registered running handle in `running` state with no terminal metadata.
