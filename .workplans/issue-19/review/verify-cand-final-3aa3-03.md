# Finding Verification: cand-3aa3-03-public-raw-denial-telemetry-bypass

Reviewed head SHA: 3aa3c6d879172b372857df93a721569e6e2d7750
Verdict: CONFIRMED

Evidence: Spec limits trusted raw-denial to sandbox-owned advisory/static evidence and reserves `denied_by_sandbox` for future OS sources. `appendPolicyGateAuditRow()` only rejects `row.rule === RAW_DATA_WRITE_RULE_ID && row.decision === "denied_by_sandbox"`, while `PolicyGateAuditRow.decision` is arbitrary string and tests append `rule: RAW_DATA_WRITE_RULE_ID, decision: "denied_by_advisory"` via public append. The WS builder likewise accepts arbitrary `rule`/`decision` and copies them into payload, with a test manually constructing `decision: "denied_by_sandbox"`.

Note: Public audit and WS builders can mint raw-denial-shaped telemetry without going through the constrained raw-data converter path.

