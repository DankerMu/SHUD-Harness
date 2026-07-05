# review-spec-compliance

Review round: post-gate follow-up after fixes
Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679

Summary: Not clean: two P1 spec-compliance gaps remain in hidden sandbox-denial evidence and timeout/abort descendant containment.

Invariant Matrix Coverage:
- Task 3.3 / policy-gate-spike 条 2': missing due to findings below.
- Governing invariant: missing for dynamic raw write OS-denied but returned allowed, and for process-group escape descendants.
- Source-of-truth identity/contract: missing for hidden-success denials.
- Producers: covered.
- Validators/preflight: missing for arbitrary-success stderr-file masking and process-group escape descendants.
- Storage/cache/query: covered.
- Public routes/entrypoints: covered for M1 scope.
- Failure paths/rollback/stale state: missing for process-group escape.
- Evidence/audit/readiness: missing for hidden OS denials that end with success.
- Six escape classes, legal raw reads/writes, hardlink residual, advisory static-write, zero unchanged: covered.

Findings:
- P1 / evidence contract: dynamic raw write with stderr redirected to workspace and trailing success can be denied by seatbelt yet reported as allowed, e.g. `d=data; r=raw; p="$d/$r/hidden.txt"; 2>workspace/err.log > "$p"; echo ok`. Required fix: classify known raw mutation targets with stderr redirected away from parent as sandbox-denial evidence even when final shell status is success; add regression.
- P1 / process cancellation: timeout/abort only kills the original process group; a `setsid()` child can survive and write. Required fix: containment beyond initial process group with timeout/abort tests.

Non-blocking notes:
- Reviewer reported OpenSpec validation and diff check passed; Bun was unavailable in that environment.
