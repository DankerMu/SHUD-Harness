Verifier verdicts for batch: compatibility-6-2-order-01 (1 candidate)
Reviewed head SHA: 3d0d35a110ed66b80a2b4cca95b1028bfdc09853

Candidate: cand-6-2-order-01
Verdict: CONFIRMED
Disposition: FIX_NOW
Evidence: `readIndex` validates checksum/canonical paths/global duplicates but never compares decoded path to its predecessor (`current-source.ts:128-195`), then sorts only candidate entries (`:206`). A checksum-rehashed v2/v3 reordered index therefore reaches the exact-set comparisons and emits public success; the same absent guard applies after v4 reconstruction. Existing authority tests have no reorder case. The public failure contract and exact authority/mismatch requirements anchor T1/T2/T3 in `design.md:905-909,930-948`.
Note: Add strict raw UTF-8 predecessor ordering before candidate filtering, normal/linked v4 rehashed rejection tests, and v2/v3 valid controls.
