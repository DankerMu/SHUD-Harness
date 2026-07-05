# Verifier verdict -- cand-observable-067-04

Verifier verdict for: cand-observable-067-04
Reviewed head SHA: 067e544368f88ec60922a243f1bcf6597f211489
Verdict: CONFIRMED
Evidence: `policy-gate-registry.test.ts:373-384` constructs `protectedRawPaths: [fixture.rawRoot]` with `createRawDataWriteAdvisoryRule([outerRawRoot])`; on deny, `policy-gate-registry.ts:250-255` routes to `denyByOuterRawPolicyGate`, which rebuilds evidence from `this.options.protectedRawPaths` at `raw-data-sandbox.ts:466,474-490`; that `profile.profileId` is emitted into payload/audit/WS via `raw-data-sandbox.ts:776,852,870` and `backend/src/ws/index.ts:49`.
Note: No guard or constructor validation ties the outer advisory rule's protected root set to the sandbox profile roots, despite the design invariant requiring advisory/sandbox denial evidence to carry the same rule/profile identity.
