# Fix List for PR #48 — final comprehensive follow-up 2de6c4e

Reviewed head SHA: `2de6c4e6f6aa1048fc232eacb21d1f42b9b88190`
Fixture: expanded / high
Verdict table: `.workplans/issue-19/review/verdict-table-final-2de6c4e.md`

Pattern escalation: yes
Failure classes:
- `path-safety`: protected raw/evidence ancestor denial was computed only from explicit `allowedWriteRoots`, while `tempRoot` is also a write-authorized root.
- `contract`: trusted raw advisory WS evidence can be mutated through the exported helper because the stored WeakMap input is returned by reference and emitted without proof revalidation/immutability.

Invariant:
- Every write-authorized root in the seatbelt profile must be considered when computing protected raw/evidence ancestor literal deny rules. A helper-created temp write root must not widen raw/evidence byte authority.
- Raw-denial `tool.failed` telemetry must be emitted from immutable sandbox-owned evidence for the actual `ToolResult`; helper callers must not be able to mutate the stored evidence before WS emission.

Fix 1: Include tempRoot in protected ancestor-deny computation (P1)
Problem:
- `tempRoot` is added to `writeAllowRoots`, but `protectedRawAncestorLiteralPaths` / `protectedEvidenceAncestorLiteralPaths` are computed only from `allowedWriteRoots`. If `tempRoot` is a broad ancestor such as `/tmp`, protected raw ancestors under `/tmp/project` remain writable.
Fix:
- Compute protected raw/evidence ancestor literal deny paths against the full write-authorized root set (`tempRoot` plus allowed write roots), or reject unsafe temp roots before profile generation.
- Ensure profile metadata/hash reflect the full ancestor-deny set.
Required tests:
- Direct sandbox regression with protected raw under a broad temp root, scoped `allowedWriteRoots=[workspace]`, advisory disabled, and `mv data data.moved; printf MUTATED > data.moved/raw/input.csv`; assert command fails, original raw path remains, and bytes unchanged.
- Profile builder regression showing raw ancestor literals are generated because of broad `tempRoot`, while scoped safe temp roots do not add unrelated ancestors.
- Audit/evidence ancestor sibling check if protected evidence paths depend on the same helper.

Fix 2: Make trusted WS evidence immutable/proof-checked at emission (P1/P2)
Problem:
- `rawDataDeniedToolResultToToolFailedEventInput(result)` returns the stored mutable WeakMap value. Same-process callers can mutate top-level or nested `ErrorRecord` fields, then `buildRawDataAdvisoryToolFailedWsEvent({ toolResult })` emits those mutated fields after only checking `rule`/`decision`.
Fix:
- Store a frozen/deep-frozen immutable trusted event input, return defensive copies from public helpers, and/or re-run the field-bound proof assertion immediately before WS emission.
- Ensure the emitted WS payload is not pass-by-reference mutable through the returned helper object.
Required tests:
- Backend/core regression: produce a trusted advisory denial `ToolResult`, retrieve the trusted input, mutate top-level fields and nested `error` fields, then assert the WS builder rejects the mutation or emits the original immutable evidence.
- Keep structural payload, spread/Object.assign trusted input, and result-shaped clone rejection tests passing.
- Confirm generic lifecycle `tool.failed` events still work.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD` must remain `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

Post-fix gate:
- Update the post-gate strategy package with this sibling-surface closure.
- Run Phase 6.2 invariant audit before the next comprehensive cross-review.
- Rerun the six-reviewer comprehensive follow-up on the fixed head.
