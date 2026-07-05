# review-correctness

Review round: post-gate follow-up after fixes
Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679

Summary: Not clean; the main raw-byte sandbox holds, but hidden interpreter evidence and timeout descendant cleanup still have actionable correctness gaps.

Invariant Matrix Coverage:
- Governing raw-byte invariant: covered - seatbelt profile denies canonical protected raw paths; hardlink residual remains documented/accepted.
- Hidden/suppressed raw-denial evidence: missing - receiver-style interpreter mutations can still become `allowed`.
- Legal raw-read/workspace-write precision: covered - target-aware copy/read cases and denial-like output regressions are present.
- Timeout/abort descendant cleanup: missing - only the original process group is killed.
- Lifecycle and denial audit append fail-closed: covered.
- Canonical workspace audit path: partially covered - absent `workspace/` project roots can still write to the wrong layout.
- Rscript legal runtime proof: covered.
- Zero adapter compatibility: out-of-scope for this follow-up commit.

Findings:
- P1 / correctness / evidence-state transition: receiver-style interpreter mutations such as `python3 -c 'from pathlib import Path; Path("data/raw/input.csv").unlink()' 2>/dev/null || true` are not recognized by the suppressed-denial guard, so a seatbelt-denied raw mutation can be reported as `allowed`. Evidence: `packages/core/src/tools/raw-data-sandbox.ts` only handles selected call-argument helpers and `Path.write_text`/`write_bytes`, not receiver delete/rename/open variants. Required fix: extend interpreter target detection for receiver-based file APIs and add seatbelt regressions for `Path.unlink`, `Path.open("w")`, and `Path.rename`.
- P1 / process cancellation / resource cleanup: timeout/abort sends `SIGKILL` to the original process group only; a descendant that calls `setsid()` can survive and write to workspace after return. Required fix: supervise/kill escaped descendants or prevent process/session escape; add timeout and abort regressions.
- P2 / audit layout / boundary input: project-root callers with `data/raw` but no pre-created `workspace/` can write audit under `projectRoot/tasks/...` instead of `projectRoot/workspace/tasks/...`. Required fix: detect project-root layout from protected raw ancestry even when `workspace/` does not exist, or split the API.

Non-blocking notes:
- Reviewer could not run Bun; review used read-only code inspection plus small seatbelt probes.
