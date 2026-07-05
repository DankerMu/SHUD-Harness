Reviewer agent: review-security-perf
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 8bbfd68eb474e9d27386fe13a05fb1b549bb5198

Summary: One blocking raw-byte integrity gap remains: a protected raw root can be displaced by renaming an allowed ancestor directory.

Invariant Matrix Coverage:
- Governing invariant: missing - direct `data/raw/**` writes are denied, but ancestor rename is not protected when an allowed write root contains `data/raw`.
- Source-of-truth identity/contract: covered - ADR/OpenSpec boundary updates match the narrowed telemetry model.
- Producers: partial - sandbox/profile, advisory, audit, and WS builders exist; profile producer lacks raw ancestor protection.
- Validators/preflight: partial - six direct escape classes are tested, but raw parent/ancestor rename is not.
- Storage/cache/query: covered - profile temp files, audit nofollow/hardlink checks, bounded hardlink scan, and zero diff checks are present.
- Public routes/entrypoints: covered - M1 only adds WS skeleton builders, no route surface.
- Frontend/downstream consumers: covered - `tool.failed` envelope/payload shape is tested.
- Failure paths/rollback/stale state: missing - parent-directory rename can leave protected raw bytes at a new path.
- Evidence/audit/readiness: partial - generic lifecycle vs trusted raw-denial telemetry is mostly separated; replay/clone hardening remains a candidate gap.
- Regression row, six escape classes: partial - listed classes are covered, but ancestor rename of `data/` is not part of the suite.
- Regression row, raw read and workspace write: covered - tests cover both under the same profile.
- Regression row, pre-existing hardlink residual: covered - residual is demonstrated and bounded scanner detects `nlink > 1`.
- Regression row, advisory denial: covered - trusted advisory denial emits remediation/audit/WS-shaped evidence.
- Regression row, zero unchanged: covered - `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; `git -C zero diff --quiet` returned 0.

Findings:
- Severity: P1
  Failure class: File IO/path safety, raw-byte integrity bypass
  Contract or invariant: A bash command may read `data/raw/**` but must not create, modify, delete, rename, or truncate protected raw-data bytes.
  Scenario or repro: With the currently supported/tested configuration `protectedRawPaths=[<root>/data/raw]` and `allowedWriteRoots=[<root>]`, run `mv data workspace/data-moved`. The source path is `<root>/data` and the destination is under `<root>/workspace`; neither path matches the generated raw deny rules for `<root>/data/raw`, so the protected raw subtree can be renamed/displaced through an allowed ancestor.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:238-257` allows writes under each allowed root and denies only the protected raw literal/subpath; `packages/core/src/tools/raw-data-sandbox.ts:414-435` has ancestor literal protection only for protected evidence paths, not raw paths; `packages/core/src/tools/raw-data-sandbox.test.ts:3937-3962` uses `allowedWriteRoots: [fixture.root]`.
  Consequence: Raw inputs can be moved out of their governed location without writing through `data/raw/**` directly, breaking the core byte-integrity/rename invariant and leaving downstream provenance/audit assumptions stale.
  Fix direction: Either fail closed when an `allowedWriteRoot` is an ancestor of a protected raw root, or add raw ancestor literal deny rules analogous to the evidence ancestor protection for every strict ancestor between the raw root and the allowed root.
  Required test or evidence: Add a seatbelt regression with `allowedWriteRoots=[fixture.root]`, advisory disabled, and `mv data workspace/data-moved`; assert the command fails and `data/raw/input.csv` remains in place. Also assert profile text contains raw ancestor deny coverage or config rejects the ancestor allowed root.
  Sibling surfaces: `createShudRuntimeToolRegistry` root resolution, profile builder tests, future Linux landlock/bwrap backend, and protected evidence ancestor logic.
  Blocks merge: Yes.

- Severity: P2
  Failure class: Evidence lineage / WS trusted telemetry boundary
  Contract or invariant: Only sandbox-tool-owned trusted advisory/static same-root raw-write evidence may become raw-denial telemetry.
  Scenario or repro: Code that receives one trusted `RawDataToolFailedEventInput` can clone it with object spread because the proof symbol is enumerable, then call `buildRawDataAdvisoryToolFailedWsEvent` repeatedly with new `seq/eventId` values. The backend validates only the copied field-bound proof, not the original `ToolResult` WeakMap binding.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:1030-1035` defines the proof property as `enumerable: true`; `packages/backend/src/ws/index.ts:50-55` accepts a `RawDataToolFailedEventInput` directly; `packages/backend/src/ws/index.ts:89-95` validates proof only, without checking `rawDataDeniedToolResultToToolFailedEventInput(result)`.
  Consequence: Same-process callers can replay or fan out raw-denial-shaped WS evidence from a prior trusted input, weakening the “actual ToolResult owns this telemetry” boundary.
  Fix direction: Make the WS advisory builder consume the actual `ToolResult` or an opaque non-cloneable capability resolved through the WeakMap at event-build time. Avoid enumerable proof copying as the trust boundary.
  Required test or evidence: Create a trusted input from a real advisory denial, clone it with object spread or `Object.assign`, and assert the raw-data advisory WS builder rejects the clone while accepting the original result-derived path.
  Sibling surfaces: `appendPolicyGateAuditRow` reserved denial rejection, backend generic `tool.failed` builder, future full WS/audit bus.
  Blocks merge: No, but should be fixed or explicitly deferred before this evidence path becomes a general audit interface.

Non-blocking notes:
- `git diff --check` on the reviewed file set returned 0.
- I did not rerun the full Bun/OpenSpec test suite in this read-only review; the report is based on code/test inspection plus the supplied CI result.

Execution Summary: agents=review-security-perf; skills=review; tools=git/sed/rg; verification=read-only diff inspection, zero diff check, diff whitespace check; limits=no file edits, no PR comments, no test execution.
