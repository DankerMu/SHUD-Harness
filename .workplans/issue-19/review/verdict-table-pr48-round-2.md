# Issue #19 PR #48 Round 2 Verifier Verdict Table

Reviewed head SHA: `2fa51433f837db2803a8eb511d2e6400aeeb3be3`

| Candidate | Verdict | Merge-blocking | Summary |
| --- | --- | --- | --- |
| V2-1 dynamic suppressed raw write reports success | CONFIRMED | Yes | Suppressed dynamic targets such as `d=data; r=raw; p="$d/$r/x"; { ... > "$p"; } 2>/dev/null || true` leave raw bytes unchanged but return success and audit `allowed`. |
| V2-2 output text false denial | CONFIRMED | Yes | Legal raw reads whose stdout contains `sandbox` or `Permission denied` can be converted into `raw_data_write_denied` because detection scans output without checking failure status. |
| V2-3 profile root/temp root symlink poisoning | CONFIRMED | Yes | Symlinked `workspace/profiles` or `workspace/tmp` to `data/raw` lets parent profile creation create/delete raw entries before sandbox execution. |
| V2-4 audit append symlink/hardlink poisoning | CONFIRMED | Yes | Parent audit append follows symlink/hardlink audit files and can mutate protected raw bytes outside the sandbox. |
| V2-5 spawn/scoped registry inherits unwrapped bash | CONFIRMED | Yes | Copying a prebuilt Zero `spawn_agent` preserves its captured old registry, so child scoped registries can still get bare `BashTool`. |
| V2-6 advisory overdenies after cwd changes | CONFIRMED | Yes | `cd workspace && printf ok > data/raw/out.txt` targets workspace scratch but is denied by advisory before seatbelt can resolve the true path. |

Phase 6.2 fix scope:
- Bind sandbox-denial conversion to failed underlying executions only; keep legal raw-read output text successful.
- Conservatively fail known denial-hiding shell forms that contain unresolved dynamic write targets.
- Reject or avoid profile roots whose lexical/canonical destination enters protected raw paths.
- Harden audit appends against symlink/hardlink destinations.
- Make advisory fail open for ambiguous relative `data/raw` after cwd-changing shell state while preserving root raw write denial.
- Rebuild or reject `spawn_agent` registry capture so child scoped registries inherit the SHUD-wrapped bash.
