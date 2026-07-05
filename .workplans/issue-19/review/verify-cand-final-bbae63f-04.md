# Phase 4.5 Verifier — cand-final-bbae63f-04-reserved-denial-public-guard

Reviewed head SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Verifier: Raman (`019f3283-1ce1-7ef1-82cc-4c0781696ca5`)
Verdict: CONFIRMED

Evidence:
- Public WS and audit builders accept `decision` fields.
- They only reject `denied_by_advisory` / `denied_by_sandbox` when `rule === RAW_DATA_WRITE_RULE_ID`.
- A caller can use `decision="denied_by_sandbox"` with another rule or no WS rule and a non-raw reserved `error_id`; the public path emits/appends it.
- The active spec reserves `denied_by_sandbox` for a future non-forgeable OS refusal event source.

Merge-blocking:
- Yes. It is a telemetry/evidence integrity gap.
