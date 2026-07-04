# review-invariant-state

Review round: post-gate follow-up after fixes
Reviewed head SHA: 73d695c53acc63eff7591baa620d840d42a1c679

Summary: Not clean: direct ee9b32c regressions are mostly addressed, but hidden alias/interpreter denials, process-group escape on timeout/abort, and one audit-root compatibility gap remain.

Invariant Matrix Coverage:
- Governing invariant: missing - false successful/evidence-losing executions and live writable descendants remain possible.
- Source-of-truth identity/contract: missing - audit root resolution can still write outside expected workspace layout.
- Producers/validators/write surfaces/evidence boundary: missing for interpreter alias forms and escaped descendants.
- Storage/cache/query: missing for project-root fallback that depends on a pre-existing `workspace/` directory.
- Public route/frontend surfaces: out-of-scope.
- Legal raw read/write, hardlink residual, advisory static write, zero clean: covered.

Findings:
- P1 / evidence-state false success for hidden sandbox denial: interpreter payloads using cwd-relative `../data/raw`, receiver-style path helpers, and symlink-only raw aliases can be denied by seatbelt but missed by wrapper target recognition. Required fix: centralize target resolution across suppressed guard and post-exec normalization, track static cwd into interpreter payloads, resolve parent-relative and existing symlink aliases, and parse receiver-style path constructors/mutators.
- P1 / timeout-abort process lifecycle escape: descendants that leave the initial process group can survive timeout/abort and mutate workspace. Required fix: prevent session/process-group escape or supervise/reap beyond the initial group.
- P2 / audit path identity/layout compatibility gap: fresh project roots with `data/raw` but no `workspace/` can write audit under `projectRoot/tasks/...` instead of `projectRoot/workspace/tasks/...`. Required fix: identify project-root layout from protected raw ancestry even when `workspace/` is absent.

Non-blocking notes:
- Review was read-only; no tests or validation commands were executed.
