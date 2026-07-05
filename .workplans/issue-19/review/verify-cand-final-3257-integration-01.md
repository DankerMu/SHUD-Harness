# Verification report -- cand-final-3257-integration-01

Candidate: outer `RAW_DATA_WRITE_RULE_ID` evaluator composition bypasses raw-denial evidence.
Reviewed head SHA: `3257f8c574b392720d8740f3c29911a54bbd1973`
Verifier agent: `019f3081-d6dd-7022-a3e1-f963d35dd18b`
Verdict: CONFIRMED

Evidence:
- `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25` says the current trusted source is same-root advisory/static raw-write intent and that denial MUST produce remediation, `tool.failed`, and audit denial evidence.
- `packages/core/src/tools/policy-gate-registry.test.ts:294-320` composes `protectedRawPaths: [fixture.rawRoot]` with `createRawDataWriteAdvisoryRule([fixture.rawRoot])`, then asserts `policy_gate_denied`, no `raw_data_write_denied`, no profile identity, and no raw audit rows.
- `packages/core/src/tools/policy-gate-registry.ts:235-250` returns immediately on outer deny through generic `buildPolicyGateDeniedResult()`.
- `packages/core/src/tools/raw-data-sandbox.ts:354-369` and `:727-750` show raw-denial evidence is built only inside `RawDataSandboxedBashTool`, after audit reservation/profile creation.

Disposition:
Blocks merge under the current #19 boundary. Fix by making outer `RAW_DATA_WRITE_RULE_ID` evaluator ownership an explicit fail-closed configuration error, rather than silently returning generic policy denial or fabricating raw profile/audit evidence.
