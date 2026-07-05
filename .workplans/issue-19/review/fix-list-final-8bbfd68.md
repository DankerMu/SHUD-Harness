# Fix List for PR #48 — final comprehensive follow-up 8bbfd68

Reviewed head SHA: `8bbfd68eb474e9d27386fe13a05fb1b549bb5198`
Fixture: expanded / high
Verdict table: `.workplans/issue-19/review/verdict-table-final-8bbfd68.md`

Pattern escalation: yes
Failure classes:
- `path-safety`: protected raw bytes can be displaced by moving an allowed ancestor directory.
- `contract`: trusted raw-denial WS telemetry can be cloned/replayed because the trusted input proof is enumerable and the backend consumes a structural event input.

Invariant:
- Raw byte authority: bash may read `data/raw/**`, but SHUD's sandboxed bash wrapper must not allow a command to create, modify, delete, rename, truncate, move, or otherwise displace protected raw-data bytes, including by first moving an ancestor directory.
- Telemetry provenance: raw-denial `tool.failed` telemetry may only be built from sandbox-owned raw-denial evidence for the actual `ToolResult`; caller-authored structural payloads, copied proof symbols, and replayed inputs must not be accepted as fresh trusted telemetry.

Invariant Surface Inventory:
- Shared helper roots: `packages/core/src/tools/raw-data-sandbox.ts`; `packages/backend/src/ws/index.ts`.
- Public entrypoints: `RawDataSandboxedBashTool.run()` via registry; `buildRawDataAdvisoryToolFailedWsEvent`; `buildToolFailedWsEvent`; public helper exports from `@shud-harness/core`.
- Read surfaces: raw reads under the seatbelt profile; `rawDataDeniedToolResultToToolFailedEventInput`.
- Write/delete/overwrite surfaces: seatbelt profile generation for protected raw roots and ancestors; broad `allowedWriteRoots` under fixture/project root; backend WS event construction from tool failure evidence.
- Producer/consumer evidence boundaries: `RawDataSandboxedBashTool` advisory evidence -> `ToolResult` -> trusted raw advisory event builder -> `tool.failed`; public generic audit/WS builders reject raw-denial shapes and reserved error IDs.
- Stale-state/idempotency boundaries: moved raw ancestors leave stale protected path identity; cloned trusted WS inputs replay stale evidence under new `seq/eventId`.
- Unchanged downstream consumers: generic lifecycle `tool.failed` events remain allowed; legal raw reads and workspace writes remain allowed; Zero source remains unchanged.

Fix 1: Protect raw ancestors under broad allowed write roots (P1)
Problem:
- Profile generation denies `file-write*` on protected raw leaf/subpath but does not deny strict ancestors between an `allowedWriteRoot` and a protected raw root. With `allowedWriteRoots=[fixture.root]`, `mv data data.moved; printf MUTATED > data.moved/raw/input.csv` can displace and mutate protected raw bytes outside the denied path.
Fix:
- Add raw ancestor literal protection analogous to the existing protected evidence ancestor literal handling, or fail closed when a broad allowed write root is an ancestor of a protected raw root.
- Keep legal raw reads and allowed workspace writes compatible.
- Ensure profile identity/hash changes when raw ancestor deny coverage changes.
Required tests:
- A seatbelt regression with broad `allowedWriteRoots=[fixture.root]`, advisory disabled, and raw ancestor move/mutate command; assert command fails or move is denied, original raw path remains in place, and original bytes are unchanged.
- A registry-level regression through `createShudRuntimeToolRegistry` for the same class.
- Profile builder evidence that raw ancestor deny coverage exists or broad-root config rejects.

Fix 2: Make trusted raw advisory WS telemetry non-cloneable/replay-resistant (P2)
Problem:
- The trusted proof symbol is enumerable and copied by object spread/Object.assign; backend `buildRawDataAdvisoryToolFailedWsEvent` accepts structural `RawDataToolFailedEventInput` plus `seq/eventId/timestamp`, so a caller with one trusted input can clone/replay it as a new WS event.
Fix:
- Move the backend trusted builder to consume the actual `ToolResult` or an opaque non-cloneable trusted capability resolved through the core WeakMap at event-build time, or otherwise make copied/cloned inputs fail validation.
- Preserve the existing public generic builder rejection behavior for raw-denial-shaped events and reserved raw-denial error IDs.
Required tests:
- Create a trusted raw advisory denial from an actual `RawDataSandboxedBashTool` result; assert the builder accepts the original result-derived path.
- Clone the trusted input using object spread or `Object.assign`; assert the raw advisory builder rejects the clone.
- Assert generic lifecycle `failed` events still work and raw-denial-shaped generic events remain rejected.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD` must remain `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

Post-fix gate:
- Run Phase 6.2 invariant audit before the next comprehensive cross-review.
- Rerun the same six-reviewer comprehensive follow-up on the fixed head.
