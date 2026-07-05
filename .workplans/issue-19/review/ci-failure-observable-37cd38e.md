# CI failure -- observable 37cd38e

PR: #48
Head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`
Workflow run: `28726553360`
Job: `check`
Conclusion: failure

Observed failures:
- `raw data seatbelt sandbox > profile builder canonicalizes paths and returns stable profile identity`
  - Linux runner canonical `/tmp` behavior caused `profile.profileText` to contain `(allow file-write* (subpath "/tmp"))`, contradicting the test expectation.
- `raw data seatbelt sandbox > interpreter-internal fragmented raw path with swallowed exception is byte-blocked without false denial telemetry`
- `raw data seatbelt sandbox > truncated hidden interpreter write scan no longer fails closed before raw mutation`
- `raw data seatbelt sandbox > chr-concatenated hidden interpreter raw write is byte-blocked without false denial telemetry`

Root pattern:
- Linux CI lacks macOS seatbelt, so most `seatbeltTest` cases skip, but several runtime `runSandboxed()` cases are plain `test(...)` and fail instead of skipping.

Related candidate:
- `cand-observable-37-05` unavailable seatbelt/interpreter skip gating.
