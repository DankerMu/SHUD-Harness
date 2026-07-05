# Follow-up Comprehensive Review — integration/API

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Reviewer: Turing (`019f329b-386d-7002-aea2-7b0644b76098`)
Verdict: FINDING

Finding:
- Severity: P2
- Failure class: public API boundary / test helper exposure
- Files:
  - `packages/core/src/tools/index.ts`
  - `packages/core/src/tools/raw-data-sandbox.ts`
- Candidate: package root exports all of `raw-data-sandbox`, including `@internal` / `ForTest` helper functions. The termination test helper can default to `process.kill`, so it should not be exposed as stable public API through `@shud-harness/core`.

Other reviewed surfaces:
- No finding for backend trusted raw-denial `ToolResult`, public audit reserved-denial rejection, SHUD runtime registry, or `zero/` pin.
