# Issue #19 PR #48 Round 1 Verifier Verdict Table

Reviewed head SHA: `8b3795c7c593638e19513a01c4100b3dc743ef43`

| Candidate | Verdict | Merge-blocking | Summary |
| --- | --- | --- | --- |
| V19-1 runtime bash entrypoint unguarded | CONFIRMED | Yes | SHUD exports/tests `RawDataSandboxedBashTool`, but the live Zero runtime still registers plain `new BashTool(fuseRules)` as `bash`; no SHUD-owned runtime assembly path wires seatbelt/advisory/audit into real bash execution. |
| V19-2 fuse rule preservation | PLAUSIBLE | Yes if runtime migration uses default wrapper | `RawDataSandboxedBashTool` defaults to `new BashTool([])`, so adding runtime wiring through the default constructor would drop Zero fuse-list safety; fix must pass a fused inner `BashTool(fuseRules)` or make unsafe construction impossible. |
| V19-3 advisory raw-copy false positive | CONFIRMED | Yes | Advisory runs before sandbox and treats any `cp ... data/raw/...` argument as a write target, blocking legal raw read plus workspace write (`cp data/raw/input.csv workspace/input.csv`). |
| V19-4 profile-file symlink poisoning | CONFIRMED | Yes | Stable profile path under sandbox-writable roots is written with plain `writeFile` before `sandbox-exec`; a symlink at that path can redirect the unsandboxed profile write into `data/raw/**`. |
| V19-5 denial evidence chain gap | CONFIRMED | Yes | Tool result and audit rows are produced in core, but backend `tool.failed` is only a standalone builder/test with handwritten payload; no actual raw denial payload drives matching WS evidence. |
| V19-6 swallowed sandbox denial | CONFIRMED | Yes | A blocked raw write can redirect stderr to `/dev/null` and return exit 0 via `|| true`; bytes are protected, but the wrapper reports success/audit allowed because denial detection depends on output text. |

Phase 6 fix scope:
- Add SHUD-owned wrapped bash registry assembly without changing `zero/`.
- Preserve fused `BashTool` behavior.
- Narrow advisory write-target classification.
- Harden profile file writes against symlink/destination poisoning.
- Build synchronized denial evidence for ToolResult, WS `tool.failed`, and audit.
- Pre-deny known suppressible shell forms while preserving legal raw reads.
