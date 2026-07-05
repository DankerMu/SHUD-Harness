# Finding Verification: cand-3aa3-04-relative-protected-evidence-test-gap

Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750
Verdict: CONFIRMED

Evidence: Spec requires relative raw/evidence/workspace roots to resolve against stable project root. Implementation resolves `protectedEvidencePaths` through `resolveRuntimeRoot`. Tests cover `protectedEvidencePaths` in the missing-root fail-closed case and an absolute registry positive, but do not cover a positive stable-root relative `protectedEvidencePaths` scenario.

Note: Add a macOS seatbelt regression for relative `protectedEvidencePaths` with `pathResolutionRoot`, changed cwd, and nested `ctx.workDir`.

