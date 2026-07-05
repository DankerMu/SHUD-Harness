# Verifier verdict -- cand-observable-37-01

Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Verdict: CONFIRMED

Evidence: `isLikelySandboxDenialForCommand()` only upgrades visible sandbox output when `!result.success && analysis.hasKnownRawWriteTarget`; known targets are lexical/static raw paths, `../data/raw`, or dynamic raw variables, while symlink resolution is not followed in `isRawDataPathToken()`. A symlink-only `workspace/link-to-raw` denial therefore falls through to generic `decision: "failed"`, and the current symlink test also includes a lexical `workspace/../data/raw/...` target.

Note: Spec requires observable symlink/alias raw denials to return remediation/tool.failed/audit denial evidence.
