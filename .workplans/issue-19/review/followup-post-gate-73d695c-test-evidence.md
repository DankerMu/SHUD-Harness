# review-test-evidence

Review round: post-gate follow-up after fixes
Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679

Summary: Most ee9b32c evidence gaps are covered, but hidden interpreter evidence and timeout/abort cleanup still have candidate blocking gaps.

Invariant Matrix Coverage:
- Governing invariant: missing - env/assignment-wrapped hidden interpreter mutations can still be audited as allowed, and timeout/abort only proves same-process-group descendants.
- Source-of-truth identity/contract: covered.
- Producers: covered.
- Validators/preflight: missing - env/assignment command wrappers and escaped-process-group cancellation are not covered.
- Storage/cache/query: covered.
- Failure paths/rollback/stale state: missing for escaped descendants.
- Evidence/audit/readiness: missing for env-wrapped suppressed interpreter denial.
- Legal raw-read/workspace-write false denial: covered.
- Hardlink residual, audit fail-closed, audit root resolution, Rscript legal runtime proof, zero clean: covered.

Findings:
- P1 / hidden-denial evidence gap: leading `NAME=value` assignment or `env` wrapper can hide the effective interpreter command, e.g. `TMPDIR="$PWD/workspace/tmp" python3 -c 'open("data/raw/env-hidden.txt","w").write("x")' 2>/dev/null || true`, causing a denied raw mutation attempt to be reported as successful. Required fix: normalize shell command prefixes before interpreter detection and add env/assignment-wrapped regressions.
- P1 / process cancellation/resource cleanup: escaped process-group descendants are not tested or killed. Required fix: timeout/abort tests for a descendant that changes process group/session before writing.
- P2 / regression evidence gap: Node `renameSync` is classifier-tested but not exercised through the sandbox wrapper runtime.

Non-blocking notes:
- The `ee9b32c` evidence files correctly record a prior blocked head and should not be treated as pass evidence for `73d695c`.
