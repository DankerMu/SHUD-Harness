# Follow-up Comprehensive Review — integration/API

Reviewed head SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Reviewer: Franklin (`019f327a-5a35-7dd1-8db3-9b7b20a36fee`)
Verdict: FINDINGS

Finding 1:
- Severity: P2
- Failure class: telemetry / reserved decision integrity
- Files:
  - `packages/backend/src/ws/index.ts`
  - `packages/core/src/tools/raw-data-sandbox.ts`
- Candidate: public WS/audit guard only blocks `denied_by_advisory` / `denied_by_sandbox` when `rule === RAW_DATA_WRITE_RULE_ID`; callers using another rule or omitting rule can still emit reserved denial-decision shape.

Finding 2:
- Severity: P2
- Failure class: runtime hardening
- File: `packages/core/src/tools/policy-gate-registry.ts`
- Candidate: runtime object carrying both `fuseRules` and `fuseListPath` will silently prefer truthy `fuseRules`, including empty array, despite TypeScript XOR intent.

Verification cited:
- `git diff --check`: pass.
- Typecheck: pass.
- `zero/` diff clean and pinned.
