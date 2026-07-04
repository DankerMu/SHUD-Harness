# PR #48 Post-Gate Verifier Verdict Table

Issue: #19
PR: #48
Reviewed head SHA: 0553fe2f60b2deb209c5201b4003e0b11606c8b6
Date: 2026-07-04

## Verdicts

| ID | Reviewer candidate | Verifier verdict | Severity | Disposition |
| --- | --- | --- | --- | --- |
| V-19-post-01 | Hidden stderr redirection can lose raw-denial evidence. | CONFIRMED | P1 | Same raw-denial evidence single-owner invariant as prior gate findings; blocks merge and triggers post-gate strategy review. |
| V-19-post-02 | `tool.failed` WS skeleton uses `event` instead of canonical `type`. | CONFIRMED | P2 | Fix before merge. |
| V-19-post-03 | Committed round-5 evidence is stale relative to final head. | CONFIRMED | P2 | Add final SHA-matched evidence artifact before merge; do not rewrite historical round-5 package. |
| V-19-post-04 | Timeout/abort kills only top process, not process tree. | CONFIRMED | P2 | Fix before merge with process-group or equivalent child-tree termination. |
| V-19-post-05 | Raw-denial tool output leaks profile path. | REFUTED | None | Current evidence contract permits `profile_path` in raw-denial payload; leakage invariant applies to running/timeout status. |
| V-19-post-06 | `tempRoot`/`profileRoot` can be inside protected evidence roots. | CONFIRMED | P2 | Fix before merge. |
| V-19-post-07 | Round-5 matrix is partially undercovered. | CONFIRMED | P2 | Cover confirmed gaps: child `bash -c cd workspace`, Node/Ruby path joins, one Python/R file-modifying form, unsuppressed existing-file redirections, abort behavior. BASH_ENV stripping, explicit-root hardlink scan, and non-macOS skips were not confirmed as gaps. |

## Key Evidence

- V-19-post-01: `RawDataSandboxedBashTool` classifies sandbox denial from parent-visible denial text; `2>workspace/err.log >data/raw/hidden.txt printf hidden` can move the denial text into an allowed workspace file, producing generic `failed` instead of `denied_by_sandbox`.
- V-19-post-02: `packages/backend/src/ws/index.ts` emits `event: "tool.failed"` while `docs/03_SPEC/WebSocket_Protocol.md` defines canonical envelope field `type`.
- V-19-post-03: round-5 artifacts are bound to `3acdba26d142cff9f9b004975fa5e29dca327dd5`; current head is `0553fe2f60b2deb209c5201b4003e0b11606c8b6`.
- V-19-post-04: timeout/abort path calls `proc.kill(signal)` on the top `sandbox-exec` process only.
- V-19-post-06: profile/temp roots are checked against protected raw roots but not protected evidence roots.

## Gate Result

Post-gate comprehensive review is not clean. Because V-19-post-01 is a confirmed P1 on the same raw-denial evidence single-owner invariant, ordinary narrow-fix looping remains closed. Proceed through a gate-level strategy review and then one root-cause remediation pass.
