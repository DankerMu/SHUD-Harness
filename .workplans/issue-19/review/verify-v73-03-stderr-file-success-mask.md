# Verifier Verdict: V73-03-stderr-file-success-mask

Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679
Verdict: CONFIRMED
Severity: P1

Evidence: `canHideSandboxFailure()` recognizes exit normalization and stderr to `/dev/null` / closed fd, but not stderr redirected to a workspace file followed by a successful command. Post-exec hidden-denial normalization also requires a failed result when no denial text is visible, so `2>workspace/err.log > "$p"; echo ok` can record `decision=allowed`.

Disposition: merge-blocking. The fix must treat target-aware raw mutations plus stderr redirected away from parent as denial-evidence candidates even when final shell status is success.
