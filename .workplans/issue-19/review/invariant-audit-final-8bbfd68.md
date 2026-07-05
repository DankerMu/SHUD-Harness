Invariant audit for PR #48
Reviewed head SHA before fix: `8bbfd68eb474e9d27386fe13a05fb1b549bb5198`
Audit target: Phase 6 closure for `.workplans/issue-19/review/fix-list-final-8bbfd68.md`

Failure classes:
- `path-safety`: broad allowed write roots could displace protected raw bytes by renaming a raw ancestor directory.
- `contract`: trusted raw advisory WS telemetry could be cloned/replayed from a structural input.

Invariant:
- Raw byte authority must protect protected raw bytes against create/modify/delete/rename/truncate/move, including ancestor-directory displacement, while preserving legal raw reads and workspace writes.
- Raw-denial `tool.failed` telemetry must be derived from sandbox-owned evidence for the actual `ToolResult`, not caller-authored or cloned structural payloads.

Invariant audit: clean

Invariant Surface Inventory coverage:
- Shared helper roots: clean - `packages/core/src/tools/raw-data-sandbox.ts` now computes `protectedRawAncestorLiteralPaths` with the same helper family as protected evidence ancestors, emits raw ancestor literal deny rules into the seatbelt profile, includes them in profile identity/hash, and stores them in profile metadata.
- Public entrypoints: clean - `RawDataSandboxedBashTool` inherits profile generation automatically; `createShudRuntimeToolRegistry` has a broad-root ancestor-rename regression; backend `buildRawDataAdvisoryToolFailedWsEvent` now accepts `toolResult`, not structural raw advisory fields.
- Read surfaces: clean - raw reads are unchanged and the focused/full test suites keep raw read and raw-to-workspace copy regressions passing.
- Write/delete/overwrite surfaces: clean - direct raw leaf/subpath writes remain denied, raw ancestor move under broad allowed root is denied and preserves bytes, and audit ancestor protections remain unchanged.
- Producer/consumer evidence boundaries: clean - sandbox tool still produces trusted evidence; backend WS builder resolves trusted input from `rawDataDeniedToolResultToToolFailedEventInput(input.toolResult)` at build time, so structural payloads and cloned result-shaped objects are rejected.
- Stale-state/idempotency boundaries: clean - moved raw ancestor no longer leaves stale raw path identity; cloned trusted input/result-shaped clones cannot be replayed as fresh trusted telemetry. Reusing the same actual `ToolResult` remains possible and is acceptable for rebuilding the same derived event evidence.
- Unchanged downstream consumers: clean - `rg` found no non-test repo callers of `buildRawDataAdvisoryToolFailedWsEvent`; generic lifecycle `tool.failed` builder behavior remains covered for raw lifecycle `failed`, raw-denial-shaped rejection, and reserved raw-denial error IDs.

Surfaces inspected:
- `packages/core/src/tools/raw-data-sandbox.ts`: clean - raw/evidence ancestor helper, profile hash/metadata/text, trusted WeakMaps, and public raw helper exports inspected.
- `packages/core/src/tools/raw-data-sandbox.test.ts`: clean - profile builder raw ancestor test and sandbox broad-root ancestor move regression present.
- `packages/core/src/tools/policy-gate-registry.test.ts`: clean - registry-level broad-root ancestor move regression present.
- `packages/backend/src/ws/index.ts`: clean - trusted raw advisory builder consumes actual `ToolResult`; generic builder still rejects raw-denial-shaped public inputs.
- `packages/backend/src/ws/index.test.ts`: clean - trusted path accepts real `ToolResult`; caller-authored structural payload, spread/Object.assign trusted inputs, and result-shaped clones are rejected.

Remaining findings:
- None.

Verification:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`: 171 pass, 0 fail.
- `pnpm --package=bun@1.2.19 dlx bun run check`: passed.
- `openspec validate m1-foundation --strict --no-interactive`: valid.
- `git diff --check`: passed.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`: passed.
- `git -C zero diff --quiet`: passed.
- `git -C zero rev-parse HEAD`: `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
