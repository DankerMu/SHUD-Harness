Reviewer agent: review-correctness
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190

Summary: Two P1 candidate gaps remain: tempRoot-derived write authority can still displace raw ancestors, and trusted WS evidence can be mutated after proofing.

Invariant Matrix Coverage:
- Governing invariant: missing - raw byte protection covers tested broad `allowedWriteRoots`, but not the valid case where `tempRoot` is an ancestor of protected raw paths.
- Source-of-truth identity/contract: covered - ADR/spec/docs consistently narrow telemetry and keep byte authority at seatbelt execution time.
- Producers: covered - bash wrapper, profile builder, advisory rule, audit helper, and WS builder are present.
- Validators/preflight: missing - tests cover allowed-write-root ancestor denial and clone rejection, but miss tempRoot ancestor authority and post-proof trusted-input mutation.
- Storage/cache/query: covered - temporary profile files and audit reservation paths are identity-checked and cleaned best-effort.
- Public routes/entrypoints: covered - no full backend WS route is introduced; only skeleton builders are changed.
- Frontend/downstream consumers: covered - `tool.failed` shape remains the only skeleton event.
- Failure paths/rollback/stale state: missing - process-result-only failures stay generic, but stale/mutated trusted WS evidence can still produce raw-denial telemetry.
- Evidence/audit/readiness: missing - audit rows are protected from public raw-denial forgery, but WS raw-denial evidence can diverge from the original trusted payload after mutation.
- Regression row, six escape classes: partially covered - direct raw writes, aliases, child processes, rename/unlink, and hidden denials are tested; ancestor displacement through `tempRoot` write authority is not.
- Regression row, raw read and workspace write: covered - focused tests preserve legal raw reads and workspace writes.
- Regression row, pre-existing hardlink residual: covered - residual is documented and bounded scanner only traverses explicit protected roots.
- Regression row, advisory raw write denial: covered - advisory remains fail-open except clear static writes and emits remediation/audit/WS evidence.
- Regression row, zero cleanliness: covered by supplied verification evidence (`git -C zero diff --quiet`, HEAD `13e25c1`).
- Boundary surfaces: partially covered - raw/audit write surfaces are mostly guarded, but tempRoot-as-write-root and mutable trusted WS evidence remain sibling surfaces.

Findings:
- Severity: P1
  Failure class: File IO/path safety/overwrite; stale authority boundary.
  Contract or invariant: A bash command must not move, rename, or otherwise displace protected `data/raw/**` bytes through any valid SHUD bash wrapper configuration.
  Scenario or repro: Configure `protectedRawPaths=[/tmp/project/data/raw]`, `allowedWriteRoots=[/tmp/project/workspace]`, and let `tempRoot` be `/tmp` or any ancestor of `/tmp/project`. The generated profile allows `file-write*` under `tempRoot`, but raw ancestor literal denies are computed only from `allowedWriteRoots`, so `/tmp/project/data` and `/tmp/project` are not denied. A command such as `mv data data.moved; printf MUTATED > data.moved/raw/input.csv` can displace the raw tree even though scoped workspace writes were the only intended user write surface.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:209` computes `protectedRawAncestorLiteralPaths` using only `allowedWriteRoots`; `packages/core/src/tools/raw-data-sandbox.ts:246` then adds `tempRoot` to `writeAllowRoots`; `packages/core/src/tools/raw-data-sandbox.ts:263` emits ancestor denies only for the earlier list.
  Consequence: On temp-backed projects or callers using a broad/default temp root, seatbelt byte authority can be widened outside the intended workspace and raw ancestors can still be displaced.
  Fix direction: Compute protected raw/evidence ancestor literal denies against every write-authorized root, including `tempRoot`, or reject any `tempRoot` that is an ancestor of protected raw/evidence roots unless equivalent ancestor literal denies are emitted.
  Required test or evidence: Add a seatbelt test with protected raw under a broad `tempRoot`, scoped `allowedWriteRoots=[workspace]`, advisory disabled, and assert `mv data data.moved` fails while original raw bytes/path remain intact.
  Sibling surfaces: `protectedEvidenceAncestorLiteralPaths`, default `tmpdir()` behavior, `createShudRuntimeToolRegistry` relative-root configurations, audit ancestor movement when audit workspace is not inside `allowedWriteRoots`.
  Blocks merge: Yes.

- Severity: P1
  Failure class: Schema/audit/WS fields; evidence lineage / stale trusted object.
  Contract or invariant: Only trusted sandbox-tool-owned advisory/static same-root raw-write evidence may become raw-denial `tool.failed` telemetry; cloned, stale, mismatched, or caller-mutated evidence must not be trusted.
  Scenario or repro: After a trusted advisory denial result is produced, a caller can obtain the WeakMap value through exported `rawDataDeniedToolResultToToolFailedEventInput(result)`, mutate it or its nested `error` object, then call `buildRawDataAdvisoryToolFailedWsEvent({ seq, toolResult: result })`. The backend reads the same mutated object from the WeakMap and emits it without re-running `assertTrustedRawDataToolFailedEventInput`.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:1024` returns the stored `RawDataToolFailedEventInput` object directly; `packages/backend/src/ws/index.ts:101` reads that object; `packages/backend/src/ws/index.ts:107` only checks rule/decision and returns it; the proof validator at `packages/core/src/tools/raw-data-sandbox.ts:1030` is now unused.
  Consequence: WS raw-denial telemetry can diverge from the original sandbox-owned evidence after proofing, reopening a sibling of the previous trusted-input replay/clone boundary.
  Fix direction: Do not expose the mutable trusted object. Validate the proof at lookup time and return a deep readonly clone, or freeze/deep-freeze the trusted input and nested `ErrorRecord` before storing it. The backend trusted builder should call the proof assertion before emitting.
  Required test or evidence: Add a test that gets a trusted result, mutates the returned trusted input or nested `error.error_id/profileId`, then verifies `buildRawDataAdvisoryToolFailedWsEvent({ toolResult })` rejects or emits the original immutable values.
  Sibling surfaces: Public core export via `packages/core/src/tools/index.ts`, backend WS builder, future AgentActivityFeed consumers, audit/WS evidence synchronization.
  Blocks merge: Yes.

Non-blocking notes:
- The follow-up fixes correctly moved generic process output back to lifecycle evidence and reject structural/cloned WS payloads by result identity.
- The raw ancestor broad-`allowedWriteRoots` regression added for `mv data data.moved` is the right shape; it just needs the tempRoot-authority sibling case.
