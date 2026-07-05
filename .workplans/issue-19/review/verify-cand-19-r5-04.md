# Finding Verification: cand-19-r5-04

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `reserveAuditEvidence` runs before bash (`packages/core/src/tools/raw-data-sandbox.ts:271-274`), but `assertSafeAuditFileTarget` only rejects symlink/non-file/hardlink targets (`packages/core/src/tools/raw-data-sandbox.ts:1813-1824`) and does not prove appendability. On denial, the code awaits `appendDenialAudit` then returns the denial result (`packages/core/src/tools/raw-data-sandbox.ts:334-345`), while `appendDenialAudit` catches append failures and only logs `policy_gate_audit_append_failed` (`packages/core/src/tools/raw-data-sandbox.ts:365-379`). The final allowed/failed audit append is also warning-only (`packages/core/src/tools/raw-data-sandbox.ts:348-354,392-414`). The fixture contract requires denial audit rows with profile identity (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25,31-32`; `openspec/changes/m1-foundation/design.md:145-147`).

Note: A regular single-link but non-writable audit file passes reservation and can lose mandatory denial evidence; post-reservation append failure is likewise suppressed.
