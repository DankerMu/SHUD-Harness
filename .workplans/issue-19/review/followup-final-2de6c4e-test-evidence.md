Reviewer agent: review-test-evidence
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190

Summary: One P2 telemetry-provenance gap remains; raw byte authority, raw ancestor rename, hardlink residual, and lifecycle separation evidence are otherwise covered.

Invariant Matrix Coverage:
- Governing raw byte invariant: covered - OS authority and six escape classes are specified in `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:21`, `:32`; implementation emits raw path and ancestor denies in `packages/core/src/tools/raw-data-sandbox.ts:209`, `:263`; integration tests run escape fixtures with advisory disabled in `packages/core/src/tools/raw-data-sandbox.test.ts:465`, `:516`.
- Source-of-truth contract: covered - 2026-07-05 telemetry boundary is reflected in spec/tasks/ADR at `policy-gate-spike/spec.md:26`, `openspec/changes/m1-foundation/tasks.md:29`, `docs/adr/0001-agent-runtime-and-topology.md:138`.
- Six escape classes: covered - interpreter, pipeline/stdin, dynamic target, shell child/grandchild, symlink/`../`, and rename/unlink are explicit fixture cases in `raw-data-sandbox.test.ts:465`.
- Raw read and workspace write positives: covered - raw reads and workspace writes are tested at `raw-data-sandbox.test.ts:1415`, `:1694`, `:1884`, `:1913`.
- Hardlink residual scan: covered - pre-existing hardlink residual is demonstrated and bounded protected-root scan detects source risk in `raw-data-sandbox.test.ts:3427`; scan only accepts explicit roots in `raw-data-sandbox.ts:1110`.
- Trusted raw-denial advisory/audit positive: covered - advisory denial returns remediation and matching audit row in `raw-data-sandbox.test.ts:2582`, `:2610`; WS trusted success path is covered in `packages/backend/src/ws/index.test.ts:23`.
- Generic lifecycle separation: covered - post-exec result maps to `allowed|failed`, not `denied_by_sandbox`, in `raw-data-sandbox.ts:611`; forged/ordinary failure regressions are in `raw-data-sandbox.test.ts:1493`, `:1612`; generic WS lifecycle remains accepted in `ws/index.test.ts:137`.
- Registry integration surface: covered - runtime registry replaces `bash` with sandboxed bash and preserves raw read/workspace write/audit behavior in `packages/core/src/tools/policy-gate-registry.test.ts:126`; spawn scoped registry inherits sandboxed bash at `:308`.
- Previous closure, raw ancestor rename: covered - profile builder, direct sandbox, and registry regressions are present at `raw-data-sandbox.test.ts:209`, `:3405`, and `policy-gate-registry.test.ts:198`.
- Previous closure, WS clone/replay: missing - structural/cloned input/result-shaped clone tests exist at `ws/index.test.ts:55`, `:67`, but the exported trusted input reference is still mutable and reused by the actual `ToolResult` builder path.
- Non-goals: covered - hidden denial telemetry and arbitrary detached lifecycle ownership are explicitly out of scope in `policy-gate-spike/spec.md:28`, `:52`; tests assert raw bytes still hold without false telemetry in `raw-data-sandbox.test.ts:2467`.
- Zero diff/head: covered - reviewer ran read-only checks: `git -C zero diff --quiet` exit 0; `git -C zero rev-parse HEAD` = `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Diff hygiene: covered - reviewer ran `git diff --check` and `git diff --check origin/main...HEAD -- packages docs openspec package.json`; both returned no output.

Findings:
- Severity: P2
  Failure class: contract / telemetry provenance
  Contract or invariant: Raw-denial `tool.failed` telemetry must be derived from immutable sandbox-owned evidence for the actual `ToolResult`; caller-authored or mutated evidence must not be accepted.
  Scenario or repro: Produce a real advisory denial `ToolResult`, call exported `rawDataDeniedToolResultToToolFailedEventInput(result)`, mutate the returned object or nested `error` fields, then call `buildRawDataAdvisoryToolFailedWsEvent({ toolResult: result, ... })`. The WS builder re-reads the same mutable WeakMap value and emits the mutated fields.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:1024` returns the stored WeakMap object by reference; `packages/backend/src/ws/index.ts:101` consumes it and `:107` only checks `rule`/`decision` before emitting; clone tests in `packages/backend/src/ws/index.test.ts:67` do not cover mutation of the returned trusted object.
  Consequence: The 8bbfd68 clone/replay closure is incomplete: a caller holding the actual result can still alter profile/error/invocation evidence before WS emission, weakening audit/telemetry provenance without touching raw bytes.
  Fix direction: Do not expose mutable trusted evidence. Deep-freeze the stored input and nested `ErrorRecord`, return defensive immutable copies, or have the WS builder rebuild from immutable stored evidence and call proof validation before emission.
  Required test or evidence: Add a regression that retrieves the trusted input from a real `ToolResult`, mutates top-level and nested fields, then verifies the WS builder either rejects or emits the original unmodified sandbox-owned evidence.
  Sibling surfaces: `assertTrustedRawDataToolFailedEventInput`, `rawDataDenialPayloadToToolFailedEventInput`, backend raw advisory builder, generic raw-denial rejection tests, and audit-row evidence conversion.
  Blocks merge: Yes for this high-risk fixture unless explicitly deferred by the orchestrator/verifier.

Non-blocking notes:
- None.

Execution Summary: agents=review-test-evidence; skills=review; tools=sed, rg, git diff/status/rev-parse; verification=read-only evidence review plus diff/zero checks, tests/OpenSpec not rerun by reviewer; limits=no file edits, commits, pushes, or PR comments.
