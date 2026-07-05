# Follow-up Comprehensive Review — security/performance

Reviewed head SHA: `a81819e601410d4b85e90f060fc8024ae8e49e78`
Reviewer: Boyle (`019f3267-ae2e-7d31-9587-c2e828f81475`)
Verdict: FINDING

Finding:
- Severity: P2
- Failure class: numerical / resource / runtime bounds
- Files:
  - `packages/core/src/tools/raw-data-sandbox.ts:1916`
  - `packages/core/src/tools/raw-data-sandbox.ts:2018`
- Evidence:
  - Every sandboxed bash invocation starts the descendant tracker.
  - Tracker samples immediately and then every `DESCENDANT_SAMPLE_INTERVAL_MS = 100`.
  - Each sample spawns `/bin/ps -axo pid=,ppid=` and reads the full process table.
  - Command timeout is caller-supplied or defaulted, with no maximum cap.
  - A long-running command can therefore cause many full-process-table scans.
- Suggested fix:
  - Avoid 100ms full-table polling for the full lifetime of normal commands.
  - Add bounded/backoff sampling or a maximum sample count while preserving timeout/abort/final teardown sampling.
  - Keep long-running task ownership out of this wrapper and in job runner / park-resume paths.

Other security surfaces:
- No new finding for seatbelt deny ordering, raw/evidence ancestor literals, audit path safety, hardlink boundary, or command injection.
