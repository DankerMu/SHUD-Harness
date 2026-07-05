# Fix list -- PR #48 observable fbc0cc0

Reviewed head SHA: `fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48`

## Confirmed finding

- `cand-observable-fbc-01`: canonical docs/specs still state that process-result-visible OS denials produce raw-denial telemetry, while current runtime/tests intentionally treat post-exec process output alone as generic lifecycle.

## Fix plan

- Update `policy-gate-spike/spec.md` clause 2' to distinguish trusted raw-denial evidence from generic post-exec lifecycle failure.
- Update `design.md` Decision 13, fixture acceptance rows, and review focus to remove process-result-only `denied_by_sandbox` requirements.
- Update `tasks.md`, ADR-0001, and `Phased_Plan.md` pointers to the same 2026-07-05 conservative telemetry boundary.
- Re-run OpenSpec validation, grep for stale process-result denial wording, `bun run check`, `git diff --check`, and zero submodule guard.

