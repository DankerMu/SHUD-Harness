# Phase 4.5 Verifier — cand-final-a81819e-01-descendant-tracker-full-ps-scan

Reviewed head SHA: `a81819e601410d4b85e90f060fc8024ae8e49e78`
Verifier: Curie (`019f326d-f0e7-7073-879a-e664286b5e53`)
Verdict: CONFIRMED

Candidate:
- The descendant tracker starts for every sandboxed bash invocation, samples every 100ms, and each sample runs `/bin/ps -axo pid=,ppid=` over the full process table.

Evidence:
- `packages/core/src/tools/raw-data-sandbox.ts:1430-1431` creates and starts the tracker for executed sandboxed bash.
- `packages/core/src/tools/raw-data-sandbox.ts:1915-1918` immediately samples and then sets `setInterval(..., DESCENDANT_SAMPLE_INTERVAL_MS)`.
- `DESCENDANT_SAMPLE_INTERVAL_MS = 100`.
- `packages/core/src/tools/raw-data-sandbox.ts:1995-2019` reaches `readProcessParentTable()` and spawns `["/bin/ps", "-axo", "pid=,ppid="]`.
- Timeout is a plain `number` defaulted to `120_000` and can be caller supplied without a maximum cap.
- No sample cap, backoff, or timeout-only sampling guard is present.

Scope decision:
- Confirmed as a P2 resource/performance gap.
- Not a raw-byte integrity gap.
- Arbitrary descendant lifecycle ownership is out of #19 acceptance, but the full-process-table polling cost is not an accepted OpenSpec boundary, so it must be handled before a clean comprehensive review can be recorded.
