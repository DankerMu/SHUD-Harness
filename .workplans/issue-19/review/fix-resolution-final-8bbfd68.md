# Fix Resolution — final comprehensive follow-up 8bbfd68

Base reviewed SHA: `8bbfd68eb474e9d27386fe13a05fb1b549bb5198`
Fix list: `.workplans/issue-19/review/fix-list-final-8bbfd68.md`
Invariant audit: `.workplans/issue-19/review/invariant-audit-final-8bbfd68.md`

Resolved findings:
- `cand-final-8bbfd68-01-raw-ancestor-rename` (CONFIRMED/P1): closed by adding protected raw ancestor literal deny coverage under broad allowed write roots, including profile metadata/hash coverage, a profile builder regression, a sandbox execution regression, and a `createShudRuntimeToolRegistry` regression.
- `cand-final-8bbfd68-02-ws-trusted-input-clone-replay` (CONFIRMED/P2): closed by changing the trusted raw advisory WS builder to consume the actual `ToolResult` and resolve sandbox-owned evidence through the core WeakMap at event-build time; spread/Object.assign cloned inputs and result-shaped clones are now rejected by tests.

Files changed by implementer:
- `packages/core/src/tools/raw-data-sandbox.ts`
- `packages/core/src/tools/raw-data-sandbox.test.ts`
- `packages/core/src/tools/policy-gate-registry.test.ts`
- `packages/backend/src/ws/index.ts`
- `packages/backend/src/ws/index.test.ts`

Verification:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`: 171 pass, 0 fail.
- `pnpm --package=bun@1.2.19 dlx bun run check`: passed.
- `openspec validate m1-foundation --strict --no-interactive`: valid.
- `git diff --check`: passed.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`: passed.
- `git -C zero diff --quiet`: passed.
- `git -C zero rev-parse HEAD`: `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Next gate:
- Commit and push this fix.
- Rerun the six-reviewer comprehensive follow-up on the new head SHA.
