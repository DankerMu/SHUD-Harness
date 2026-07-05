Reviewer agent: review-integration
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190

Summary: One blocking P2 integration finding remains in trusted WS evidence immutability; raw byte authority and raw ancestor displacement fixes otherwise integrate cleanly.

Invariant Matrix Coverage:
- Governing invariant: missing - raw byte protection is covered, but trusted raw-denial telemetry can still be caller-mutated in place before WS event construction; see Finding 1.
- Raw ancestor displacement closure: covered - `protectedRawAncestorLiteralPaths` is computed, emitted into the seatbelt profile, stored in metadata, and included in profile identity/hash.
- Direct sandbox broad-root raw ancestor move: covered - `raw ancestor move under broad allowed root is denied and preserves bytes` regression covers `mv data data.moved`.
- Registry broad-root raw ancestor move: covered - `createShudRuntimeToolRegistry` regression exercises the same ancestor move through wrapped runtime `bash`.
- Byte authority vs telemetry authority: missing - byte authority remains owned by seatbelt, but telemetry authority still trusts a mutable WeakMap value without rechecking the field-bound proof.
- Static advisory fail-open behavior: covered - advisory remains pre-exec/fail-open; post-exec failures stay generic lifecycle evidence.
- Trusted raw advisory provenance: missing - structural and cloned result inputs are rejected, but public access to the original trusted input allows in-place mutation accepted by the backend builder.
- Public audit append boundary: covered - public audit append rejects raw-denial rows and reserved raw-denial error IDs while allowing generic lifecycle rows.
- Generic backend `tool.failed` boundary: covered - generic builder rejects raw-denial-shaped events and reserved raw-denial error IDs, while allowing raw-rule lifecycle `failed`.
- Policy gate registry integration: covered - runtime registry replaces `bash` with the sandboxed wrapper and preserves raw-read/workspace-write behavior under the wrapper.
- Profile/audit root identity binding: covered - profile and audit root identity checks remain in the shared sandbox helper path.
- Process/subprocess inheritance and escape classes: covered for #19 acceptance boundary - tests cover child/interpreter/suppressed/timeout classes while docs explicitly defer complete hidden-denial telemetry and arbitrary descendant lifecycle ownership.
- Hardlink residual handling: covered - residual is documented and bounded scanner support remains present.
- Legacy raw-read compatibility: covered - raw read and raw-to-workspace copy tests remain present across shell/interpreter paths.
- Wrapper/proxy faithfulness to Zero: covered - `zero` diff is clean and pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Evidence lineage and schema shape: missing - WS payload shape is correct, but lineage can be altered through mutable trusted input before event emission.
- Documentation/OpenSpec alignment: covered - docs/specs match the narrowed byte-authority vs telemetry-authority boundary.
- Full production audit ingestion/UI consumers: out-of-scope - M1 scope is the producer and WS skeleton payload, not full persistence/UI ingestion.
- Previous finding `cand-final-8bbfd68-01-raw-ancestor-rename`: covered - direct and registry regressions close the ancestor displacement path.
- Previous finding `cand-final-8bbfd68-02-ws-trusted-input-clone-replay`: partially covered - structural/cloned inputs are rejected, but a same-result in-place mutation gap remains; see Finding 1.

Findings:
- Severity: P2
  Failure class: contract / evidence-provenance / mutable trusted capability
  Contract or invariant: Raw-denial `tool.failed` telemetry must be derived from sandbox-owned, field-bound evidence for the actual `ToolResult`; caller-authored mutations must not be accepted as trusted evidence.
  Scenario or repro: A backend/integration caller receives an actual advisory-denied `ToolResult`, calls the exported `rawDataDeniedToolResultToToolFailedEventInput(result)`, mutates the returned object in place, then calls `buildRawDataAdvisoryToolFailedWsEvent({ toolResult: result })`. Because the backend reads the same WeakMap value and only checks `rule`/`decision`, the emitted trusted WS event contains the caller-mutated `profileId`, `error_id`, remediation, or evidence fields.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:1024` returns the mutable WeakMap value; `packages/core/src/tools/raw-data-sandbox.ts:1051` stores a field-bound proof, but `packages/backend/src/ws/index.ts:98` only resolves the WeakMap value and checks `rule`/`decision` before `packages/backend/src/ws/index.ts:58` spreads it into the event.
  Consequence: Downstream WS consumers can receive a raw-denial event that appears trusted and result-bound while carrying caller-authored telemetry fields.
  Fix direction: In `readRawDataAdvisoryToolFailedWsEventInput`, re-run `assertTrustedRawDataToolFailedEventInput(trustedInput)` after WeakMap lookup before building the event; preferably also deep-freeze trusted evidence or make `rawDataDeniedToolResultToToolFailedEventInput` return a defensive clone that cannot mutate the stored trusted value.
  Required test or evidence: Add a regression that obtains a real trusted `ToolResult`, retrieves the trusted input, mutates both top-level and nested `error` fields, then verifies `buildRawDataAdvisoryToolFailedWsEvent({ toolResult })` rejects the mutation or emits the original immutable evidence. Keep existing structural/spread/Object.assign clone rejection tests.
  Sibling surfaces: core trusted helper export, backend raw advisory WS builder, `assertTrustedRawDataToolFailedEventInput`, future WS/audit consumers that trust raw-denial payload fields.
  Blocks merge: Yes, because this high-risk fixture treats raw-denial telemetry as trusted sandbox-owned evidence only.

Non-blocking notes:
- None.

Execution Summary: agents=review-integration; skills=review; tools=git/rg/sed/nl/temp-seatbelt-probe; verification=checked target SHA, diff scope, raw ancestor/registry/WS code paths, docs/OpenSpec alignment, `git diff --check`, scoped diff check, zero diff cleanliness and pinned zero HEAD; limits=read-only review, no edits, no commits, no PR comments, no subagents, full `bun run check` and OpenSpec validation not rerun locally.
