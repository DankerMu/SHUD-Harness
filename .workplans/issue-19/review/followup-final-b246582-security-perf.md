# Follow-up Comprehensive Review — security/performance

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Reviewer: Confucius (`019f329b-4370-7260-8502-913b411b6c34`)
Verdict: FINDINGS

Finding 1:
- Severity: P1
- Failure class: telemetry / mutable input TOCTOU
- File: `packages/core/src/tools/raw-data-sandbox.ts`
- Candidate: `appendPolicyGateAuditRow()` validates `options.row`, then awaits audit reservation, then writes the same mutable `options.row` reference. A caller can mutate the row after validation and before append to forge a reserved raw-denial audit row.

Finding 2:
- Severity: P2
- Failure class: bounded scan / resource runtime bounds
- File: `packages/core/src/tools/raw-data-sandbox.ts`
- Candidate: `scanProtectedHardlinks()` applies `maxScannedPathCount` only after canonicalizing all `protectedRoots`; `canonicalizePathSet()` runs all `realpath` calls through `Promise.all`, so a large root list can cause unbounded concurrent work before the budget applies.

Other reviewed surfaces:
- No new command injection finding.
