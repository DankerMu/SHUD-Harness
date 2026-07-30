# Issue #172 implementation evidence

Issue: #172
Branch: `codex/issue-172-proof-harness`
Base: `origin/main` at `edc5ec5`
Frozen proof source: `526f86d5522423823e9909937f166d72b7c2a49c`
Fixture: `expanded`; repair intensity: `high`

## Scope

The proof source changes only the OpenSpec ownership overlay and six test-only files under `spikes/git-status-capability/contracts/tests/authority-{vocabulary,structural.test,runtime.test,control,preload,worker}.ts`. Production `contracts/{check.ts,lib/**}`, schemas, package files, workflows, and network-security surfaces are unchanged.

The versioned `shud.contract.authority-proof.v2` registry contains exactly 55 rows. Its ordered semantic tuple projection is independently bound in both proof modules to SHA-256 `8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725`. Structural tests compile every mutation in the real `check.ts` entrypoint and reject it without loading the active preload. Runtime tests traverse the same registry without importing the structural scanner and deny concrete post-admission Worker/Node/Bun/FFI/child/write operations before raw delegation. Generator rows execute with `.next()` and asynchronous rows are awaited.

A bounded admission-phase Worker canary proves the exact fixture URL, worker entry, input read, sentinel write, message receipt, termination, and cleanup before hostile rows. Independent raw read and FFI inversion canaries prove that the raw-operation event channel observes delegation before denial; every hostile row and direct success records zero raw events.

## Historical binding and corrected facts

- PR #170 terminal reviewed HEAD: `02ba5189e938c7c04018555ec0347945dc15e829`.
- Original #168 `.workplans/issue-168/red-proof-round-1.md`: 1,932 bytes; SHA-256 `4058179a37ec7fdef5255c307f3602fea6b0aee46e512c553c1faf32f3505924`. The byte-identical copy records restored green as 23 pass / 0 fail / 529 assertions.
- PR #170 body snapshot: 3,463 bytes; SHA-256 `4a0d936e5907fd9df8dd358d80a2a98fdb84182aeee112a7e21b8c5b51b00307`.
- Round-5 verifier A/B/C source artifacts: 1,059 / 1,294 / 2,107 bytes and SHA-256 `bdd73fd85356d33cd3b7e12c4966428930ce51cdbf894acdd78eaf843840fa66`, `b6c0e8bb381ca905949cc259687c9218e4dae0e71a6bb88385c4e9ce80152e32`, and `64d95d07f1f3e77bb5c0c34980d4df269fc91a53dc1a49c7dfc9b70f1ed18cc9`.
- Independent Bun 1.2.19 recomputation: `recordWithEntries(237)` serializes to 5,100 bytes and `recordWithEntries(238)` to 5,116 bytes. The stale 8,339/8,364 claims are not repeated as current facts.

## Round 1 review closure

Reviewed head `2ddf11d9360f0450e9ebe2d146798fdb030d0093` was `not-clean`: seven verified P1/FIX_NOW findings in authority coverage, test evidence, spec completeness, and evidence completeness. The repair:

- added reflective/dynamic/destructured constructor and computed `import.meta["require"]` rows plus exact Object/element/binding structural baselines;
- added bare `worker_threads` static/dynamic/getBuiltin/createRequire/cached rows alongside node-prefixed rows;
- added independent version/count/tuple-digest bindings;
- added raw-operation inversion and Worker-liveness canaries;
- restored the two deleted ingestion exact-bound/malformed OpenSpec scenarios;
- reserved tracked evidence persistence for this evidence-only descendant commit.

Verified non-fix dispositions: BunFile/fd and broad FFI sibling candidates were CONFIRMED/DISCARD as outside the finite proof contract; pre-admission gated Worker/child and partial-admission marker candidates were REFUTED by the declared control model and landed #171 descriptor-chain oracle.

## Verification at frozen proof source

- Darwin Bun 1.2.19 focused proof: 8 pass / 0 fail / 488 assertions.
- Darwin Bun 1.2.19 full contracts suite: 37 pass / 0 fail / 1,455 assertions.
- Linux `oven/bun:1.2.19` read-only focused proof: 8 pass / 0 fail / 488 assertions.
- Linux `oven/bun:1.2.19` read-only full contracts suite: 37 pass / 0 fail / 1,407 assertions.
- Both public direct commands retain exit 0, empty stderr, and one exact LF-terminated receipt each:
  - `{"schema_version":"shud.git-status-capability.contract-check-receipt.v1","status":"ok","input_kind":"source_input_record"}`
  - `{"schema_version":"shud.git-status-capability.contract-check-receipt.v1","status":"ok","input_kind":"source_identity_projection"}`
- Registry deletion red proof: removing one row made both independent modules fail the frozen count oracle, expected 55 / received 54.
- Registry tuple red proof: changing the first denial operation made both modules fail the digest oracle, expected `8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725` / received `75a5bbf75e83fea9411a1a761e07e417e8936b6bde95f6415ac3fcac04b4e0f8`; exact source was restored and focused proof returned green.
- `npx --yes bun@1.2.19 run typecheck`: pass.
- `npx --yes bun@1.2.19 run check`: pass.
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-capability-observer-spike --strict`: valid.
- `git diff --check`: pass before the proof-source commit.

Fresh-worktree prerequisites only: the root installed dependency tree supplied declared `typescript@5.8.3` during tests and the pinned `zero` gitlink `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` was initialized for repository typecheck. Neither changes the PR.

## Deviations

None. No production behavior, dependency, manifest, workflow, network-security, or scientific-governance surface changed.
