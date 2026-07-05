Reviewer agent: review-invariant-state
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 8bbfd68eb474e9d27386fe13a05fb1b549bb5198

Summary: One blocking invariant gap remains: raw ancestors are not protected against rename/move when an allowed write root contains the protected raw parent.

Invariant Matrix Coverage:
- Governing invariant: missing - direct `data/raw/**` writes/deletes/truncates are covered, but ancestor rename can stale the protected path and then mutate the same raw bytes; see finding.
- Source-of-truth identity/contract: covered - policy-gate-spike 条 2' and ADR updates define byte authority, advisory telemetry, profile identity, audit, and WS boundaries.
- Producers: missing - the profile producer allows broad write roots and denies raw leaf/subpath only, unlike evidence paths where ancestors are also protected.
- Validators/preflight: missing - tests cover direct six escape classes, but no regression covers moving `data/` or another protected raw ancestor before writing through the moved path.
- Storage/cache/query: covered - audit reservation uses canonical workspace placement, no-follow/hardlink checks, handle identity, and protected evidence paths.
- Public routes/entrypoints: out-of-scope - no full backend WS route is implemented in this M1 slice; only the skeleton event builder is in scope.
- Frontend/downstream consumers: covered - backend generic `tool.failed` rejects raw-denial-shaped input and trusted advisory raw-denial uses the dedicated builder.
- Failure paths/rollback/stale state: missing - stale raw path authority after raw ancestor rename is not prevented or tested.
- Evidence/audit/readiness: covered - trusted advisory denial audit/WS payloads and generic lifecycle `failed|allowed` rows are separated; hardlink residual scanner evidence is present.
- Six escape classes regression row: partially covered - interpreter, pipeline/stdin, dynamic target, child/grandchild, symlink/`../`, and direct rename/unlink are tested; raw ancestor rename is missing.
- Raw read / workspace write compatibility row: covered - raw reads, workspace writes, and waited foreground child process writes are tested.
- Pre-existing hardlink residual row: covered - residual behavior is explicitly demonstrated and bounded `nlink>1` scan is tested.
- Advisory raw-denial row: covered - trusted sandbox-owned advisory denial produces remediation-shaped result, audit row, and WS input; structural forged payloads are rejected.
- Zero compatibility row: covered - implementation stays in SHUD-owned packages and the supplied verification reports `zero` diff clean at `13e25c1`.

Findings:
- Severity: P1
  Failure class: Raw-byte invariant bypass / stale path authority
  Contract or invariant: A bash command may read `data/raw/**` but must not create, modify, delete, rename, or truncate protected raw-data bytes through the SHUD bash wrapper.
  Scenario or repro: With the current public/test configuration pattern where `allowedWriteRoots` contains the project root, run `mv data data.moved; printf MUTATED > data.moved/raw/input.csv` with advisory disabled or with no literal `data/raw` target. The profile denies the original raw leaf/subpath, but not the `data` ancestor, so after the ancestor move the same raw bytes are reachable through a path outside the protected profile.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts:238` allows writes under each allowed root; `packages/core/src/tools/raw-data-sandbox.ts:251` denies only protected raw/evidence leaf and subpath entries; raw ancestors are not added to the deny list while evidence ancestors are handled separately at `packages/core/src/tools/raw-data-sandbox.ts:255`. The test helper configures `allowedWriteRoots: [fixture.root]` at `packages/core/src/tools/raw-data-sandbox.test.ts:3952`, and direct rename coverage only targets `data/raw/...` at `packages/core/src/tools/raw-data-sandbox.test.ts:477`.
  Consequence: The wrapper can return a generic success or failure while raw evidence bytes have been moved outside the protected path and then modified in the same invocation, breaking the core byte-integrity guarantee.
  Fix direction: Either reject any `allowedWriteRoots` that are ancestors of protected raw roots unless raw ancestors are explicitly protected, or add literal deny rules for protected raw ancestors inside allowed write roots, mirroring the protected evidence ancestor strategy. Keep workspace writes allowed by narrowing the configured write root to `workspace` where possible.
  Required test or evidence: Add a seatbelt regression with `allowedWriteRoots` containing the project root: `mv data data.moved; printf MUTATED > data.moved/raw/input.csv`; assert the command fails or the move is denied, original raw bytes remain unchanged, and audit records no false `allowed` lifecycle. Add the same check through `createShudRuntimeToolRegistry`.
  Sibling surfaces: `buildRawDataSeatbeltProfile`, `RawDataSandboxedBashToolOptions.allowedWriteRoots`, registry setup examples/tests, future Linux landlock/bwrap backend, audit protected-evidence ancestor handling, hardlink residual scanner assumptions.
  Blocks merge: Yes

Non-blocking notes:
- Review was read-only; I did not rerun local tests or mutate fixtures, and relied on source inspection plus the supplied verification summary.
