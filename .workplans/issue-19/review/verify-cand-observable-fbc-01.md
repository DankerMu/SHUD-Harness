# Verification report -- cand-observable-fbc-01

Candidate: OpenSpec/ADR telemetry contract still describes removed post-exec `denied_by_sandbox`.
Reviewed head SHA: `fbc0cc009b3fbed1c0c3f79c09bf9ea12dffdc48`
Verifier agent: `019f3072-4e43-71f3-a22e-af532c64006a`
Verdict: CONFIRMED

Evidence:
- `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:25` required process-result-visible OS denials to emit remediation, `tool.failed`, audit, and `decision=denied_by_sandbox`.
- `openspec/changes/m1-foundation/design.md:178` repeated process-result observable denial -> `decision=denied_by_sandbox`.
- `packages/core/src/tools/raw-data-sandbox.ts:414-419` records post-sandbox lifecycle only as `allowed`/`failed`.
- `packages/core/src/tools/raw-data-sandbox.test.ts:3103-3115` asserts the visible raw write denial stays generic with no sandbox-denial telemetry.

Disposition:
Update canonical OpenSpec/ADR/plan wording to match the fbc0cc0 implementation boundary: post-exec process output alone is generic lifecycle in M1; trusted advisory/static raw-denial evidence may emit raw-denial telemetry; `denied_by_sandbox` is reserved for a future non-forgeable OS denial source.
