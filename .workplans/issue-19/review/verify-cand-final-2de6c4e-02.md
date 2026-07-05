Verifier verdict for: cand-final-2de6c4e-02-mutable-trusted-ws-evidence
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190
Verdict: CONFIRMED
Evidence: `raw-data-sandbox.ts:963-968` stores `evidence.toolFailedEventInput` in `trustedRawDataToolFailedEventInputsByResult`, and `raw-data-sandbox.ts:1024-1027` returns that WeakMap value directly. `ws/index.ts:101-113` then reads the same object and only checks `rule`/`decision` before `ws/index.ts:58-63` spreads it into the emitted event; nested `error` is passed by reference at `ws/index.ts:73-80`. The proof guard exists at `raw-data-sandbox.ts:1030-1043` but is not called by the backend builder.
Note: Mutation of `profileId`, `invocationId`, or nested `error.error_id`/remediation/message after lookup is constructible and would be emitted if `rule` remains `raw-data-write` and `decision` remains `denied_by_advisory`.
