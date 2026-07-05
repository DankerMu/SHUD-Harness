# Verification report -- cand-final-789-security-01

Candidate: public raw-denial builders can mint reserved `denied_by_sandbox` authority.
Reviewed head SHA: `789485ad5ad8bc75a560c0df5fdc12eb7137fee3`
Verifier agent: `019f3094-d52e-7853-be4f-2c673aee8e2a`
Verdict: CONFIRMED

Evidence:
- `packages/core/src/index.ts:3` publicly re-exports `./tools/index`.
- `packages/core/src/tools/index.ts:12` publicly re-exports `./raw-data-sandbox`.
- `packages/core/src/tools/raw-data-sandbox.ts:673-768` exported builders accepting `decision: "denied_by_sandbox"` and minting `raw_data_write_denied` / failed tool results.
- `packages/core/src/tools/raw-data-sandbox.ts:770-802` converted the payload decision into audit/WS inputs.
- `packages/backend/src/ws/index.test.ts:45-66` constructed the reserved shape through public core builders.
- `policy-gate-spike/spec.md:25` reserves `decision=denied_by_sandbox` for a future non-forgeable OS event source.

Disposition:
Blocks merge under the current boundary. Public builders/converters must not mint reserved sandbox authority; M1 public helpers may expose advisory denial construction only, while reserved sandbox shape coverage must use local fixtures or a future opaque trusted OS-event source.
