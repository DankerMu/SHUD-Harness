Reviewer agent: review-invariant-state
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190

Summary: One P2 evidence-provenance gap remains: the WS raw-denial builder now derives from the actual `ToolResult`, but the exported trusted-event helper exposes the mutable internal evidence object.

Invariant Matrix Coverage:
- Governing raw byte invariant: covered - raw ancestor literal deny paths are added to profile identity/text/metadata at `packages/core/src/tools/raw-data-sandbox.ts:209` and `packages/core/src/tools/raw-data-sandbox.ts:263`; broad-root ancestor move regression preserves bytes at `packages/core/src/tools/raw-data-sandbox.test.ts:3405`.
- Profile producer: covered - canonical raw/evidence roots, raw ancestor literals, profile hash input, and metadata are produced together at `packages/core/src/tools/raw-data-sandbox.ts:204`.
- Raw/evidence ancestor guards: covered - shared ancestor helper covers raw and evidence paths at `packages/core/src/tools/raw-data-sandbox.ts:427`; registry-level broad-root regression is present at `packages/core/src/tools/policy-gate-registry.test.ts:198`.
- Sandbox execution path: covered - profile is created before advisory/sandbox execution and cleaned after lifecycle/audit append at `packages/core/src/tools/raw-data-sandbox.ts:534`.
- Registry integration: covered - SHUD runtime replaces bash with `RawDataSandboxedBashTool` and wraps all runtime tools at `packages/core/src/tools/policy-gate-registry.ts:110` and `packages/core/src/tools/policy-gate-registry.ts:129`; raw read/workspace write compatibility is covered at `packages/core/src/tools/policy-gate-registry.test.ts:152`.
- WS trusted evidence path: missing - structural payload and clone rejection is covered at `packages/backend/src/ws/index.test.ts:55` and `packages/backend/src/ws/index.test.ts:67`, but the actual trusted input object returned from the exported helper remains mutable and is consumed without proof revalidation.
- Generic lifecycle compatibility: covered - public generic `tool.failed` rejects raw-denial-shaped/reserved IDs while allowing raw lifecycle failures at `packages/backend/src/ws/index.ts:85` and tests at `packages/backend/src/ws/index.test.ts:111`.
- Previous 8bbfd68 raw ancestor finding: covered - fixed at invariant level, not only line level, by profile producer + sandbox + registry regressions.
- Previous 8bbfd68 structural clone/replay finding: partially covered - clone/replay via copied structural inputs is closed, but mutable same-object replay remains a sibling evidence-provenance gap.

Findings:
- Severity: P2
  Failure class: contract
  Contract or invariant: Raw-denial `tool.failed` telemetry must be derived from sandbox-owned evidence for the actual `ToolResult`, not caller-authored or later-mutated structural payload.
  Scenario or repro: A caller obtains a real advisory-denial `ToolResult`, calls exported `rawDataDeniedToolResultToToolFailedEventInput(result)`, mutates the returned object or nested `error` record, then calls `buildRawDataAdvisoryToolFailedWsEvent({ seq, toolResult: result })`. The backend builder dereferences the same WeakMap object and emits the mutated profile/error evidence.
  Evidence: `packages/core/src/tools/index.ts:12` exports the helper publicly; `packages/core/src/tools/raw-data-sandbox.ts:1024` returns the WeakMap value directly; `packages/backend/src/ws/index.ts:101` consumes that object and only checks `rule/decision`, without `assertTrustedRawDataToolFailedEventInput`.
  Consequence: A trusted sandbox result can still produce caller-altered WS evidence, reopening the provenance class that the ToolResult-based fix was meant to close.
  Fix direction: Keep trusted evidence immutable or copy-on-read, and make the WS builder revalidate the proof over the exact object it emits. A practical fix is to deep-freeze the stored `RawDataToolFailedEventInput`/`ErrorRecord`, return defensive copies from public helpers, and call proof validation before event construction.
  Required test or evidence: Add a backend/core regression that mutates `trusted.input.profileId` and `trusted.input.error.error_id` after `rawDataDeniedToolResultToToolFailedEventInput(result)` and asserts the WS builder rejects it or emits the original immutable evidence.
  Sibling surfaces: `assertTrustedRawDataToolFailedEventInput`, `rawDataDeniedToolResultToToolFailedEventInput`, `buildRawDataAdvisoryToolFailedWsEvent`, future full AuditEvent/WS route consumers, and any helper returning trusted evidence by reference.
  Blocks merge: Yes under this high-risk evidence-provenance fixture unless explicitly deferred.

Non-blocking notes:
- I did not rerun the supplied verification commands; review was read-only source/diff inspection. The supplied local verification claims 171 focused tests, full `bun run check`, OpenSpec validate, diff checks, and zero diff/head passed.

Execution Summary: agents=review-invariant-state; skills=review,risk-adaptive-cross-review; tools=git,rg,nl,sed; verification=read-only inspection only; limits=no tests rerun, no edits.
