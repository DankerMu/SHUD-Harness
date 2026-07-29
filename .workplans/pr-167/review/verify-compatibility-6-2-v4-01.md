Verifier verdicts for batch: compatibility-6-2-v4-01 (1 candidate)
Reviewed head SHA: 3a61a5449aae4620189d18112d5c2e9f066b1ec3

Candidate: cand-6-2-v4-01
Verdict: CONFIRMED
Disposition: FIX_NOW
Evidence: `readIndex` verifies only the final object checksum (`current-source.ts:133-135`) then stops after declared entries without requiring `cursor === bytes.length - oidLength` or parsing extension framing (`:140-193`), so a checksum-rehashed trailing byte or incomplete extension is accepted. It filters to candidates before duplicate detection (`:187-192`), so a duplicate stage-0 noncandidate is not rejected. `checkCurrentSourceAuthority` can then emit public success after manifest/filesystem equality (`:283-295`). The OpenSpec requires exact Git-tracked manifest authority (`spec.md:345-357`) and exact public failure receipt (`design.md:905-909`); valid-v4 tests do not cover malformed cases.
Note: T1/T2/T3 pass. Add normal/linked public rehashed malformed-extension and duplicate-noncandidate cases with exact failure/no-write/no-child proof.
