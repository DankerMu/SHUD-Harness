# Finding Verification: cand-3aa3-02-public-helper-relative-root-drift

Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750
Verdict: CONFIRMED

Evidence: Spec requires relative raw/evidence/workspace roots to resolve via an explicit stable project root and fail closed without it. Exported helpers lack that option/guard: `AppendPolicyGateAuditRowOptions` only has `workspaceRoot`/`protectedRawPaths`; `appendPolicyGateAuditRow()` calls `resolve(options.workspaceRoot)`; `buildRawDataSeatbeltProfile()` canonicalizes `options.protectedRawPaths` directly; `scanProtectedHardlinks()` canonicalizes `input.protectedRoots` directly; `canonicalizeExistingPath()` is `realpath(resolve(path))`, so relative helper inputs bind to `process.cwd()`.

Note: Runtime wrapper tests cover `pathResolutionRoot`, but exported sibling helper entrypoints remain reachable through the public tools export.

