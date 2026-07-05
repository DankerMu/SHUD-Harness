# Finding Verification: cand-19-r5-07

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:197-199` denies `file-write*` under protected raw paths, but runtime denial normalization at `packages/core/src/tools/raw-data-sandbox.ts:334-345` depends on `isLikelySandboxDenialForCommand`; failed results then require `hasFailedResultRawWriteSignal` at `packages/core/src/tools/raw-data-sandbox.ts:1546-1550`. Its literal write allowlist at `packages/core/src/tools/raw-data-sandbox.ts:1574-1583` covers `cp|mv|tee|touch|mkdir|truncate|chmod|chown|chgrp|xattr|rm|unlink|dd|install|ln` or explicit interpreter write APIs, not `sed -i` or `perl -pi` file-operand mutation. The fallback at `packages/core/src/tools/raw-data-sandbox.ts:348-354` audits `decision: "failed"` and returns the underlying command failure. Spec requires OS-layer raw write denials to return remediation-shaped `tool.failed` and audit `decision=denied_by_sandbox` (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23-25,31-32`; `openspec/changes/m1-foundation/design.md:175,178`).

Note: None.
