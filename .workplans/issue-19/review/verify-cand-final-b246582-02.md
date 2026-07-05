# Phase 4.5 Verifier — cand-final-b246582-02-internal-test-helper-export

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Verifier: Volta (`019f32a2-4578-7381-8f37-7b8552603ae3`)
Verdict: CONFIRMED

Evidence:
- `packages/core/src/index.ts` exports `./tools/index`.
- `packages/core/src/tools/index.ts` exports `./raw-data-sandbox`.
- `@internal` / `ForTest` helper symbols are explicitly exported from `raw-data-sandbox.ts`.
- The termination helper passes default options through to a helper that defaults signaling to `process.kill`.

Merge-blocking:
- Yes. The public-entrypoint boundary is the wrapped bash `run()` path, not raw process-termination helpers.
