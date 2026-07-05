# Finding Verification - cand-final-e4f00c3-04

Verifier verdict for: cand-e4f00c3-04-generic-ws-error-snapshot
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`
Verdict: CONFIRMED

Evidence: `buildToolFailedWsEvent()` reaches `buildToolFailedWsEventUnchecked()` after only raw-denial guards, and the unchecked builder assigns `payload.error` as `error: input.error` (`packages/backend/src/ws/index.ts:50-52`, `74-77`, `86-97`). `ErrorRecord` contains mutable fields/arrays and nested `remediation`, so mutating the caller-owned record after build changes the queued event payload.

Note: Existing mutation-isolation coverage applies to the raw-data advisory path, not the generic builder.
