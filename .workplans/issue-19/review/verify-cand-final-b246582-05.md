# Phase 4.5 Verifier — cand-final-b246582-05-public-raw-denial-builders

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Verifier: Aristotle (`019f32a2-6d41-74a0-8db8-ecede1649ca8`)
Verdict: CONFIRMED

Evidence:
- Package root publicly re-exports `raw-data-sandbox`.
- `buildRawDataDeniedPayload()` and `buildRawDataDeniedToolResult()` are exported.
- These builders construct reserved-looking `raw_data_write_denied` / `decision="denied_by_advisory"` payload and tool-result values.

Merge-blocking:
- Yes under the public reserved-decision unforgeability invariant.
