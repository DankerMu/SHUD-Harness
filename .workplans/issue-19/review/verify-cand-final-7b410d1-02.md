# Finding Verification: cand-7b410d1-02-reserved-raw-error-id-smuggling

Reviewed head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc
Verdict: CONFIRMED

Evidence: Generic WS and public audit append guards checked raw-data-write plus denied decision, but copied `ErrorRecord.error_id` or audit `error_id` through unchanged. The spec limits trusted raw-denial telemetry to sandbox-owned advisory/static evidence and reserves `denied_by_sandbox` for future OS sources.

Note: A lifecycle `decision="failed"` row/event with `error_id="raw-data-write:denied_by_sandbox:fake"` was constructible through public builders.
