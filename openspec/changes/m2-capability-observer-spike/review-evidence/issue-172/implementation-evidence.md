# Issue #172 implementation evidence

Issue: #172
Branch: `codex/issue-172-proof-harness`
Base: `origin/main` at `edc5ec5`
Frozen proof source: `631d8e30304d4bf4b4a8a7fb79ae38231e3ae7e4`
Fixture: `expanded`; repair intensity: `high`

## Scope

The proof source changes only the OpenSpec ownership overlay and seven test-only files under `spikes/git-status-capability/contracts/tests/`: `authority-{vocabulary,structural.test,topology,runtime.test,control,preload,worker}.ts`. Production `contracts/{check.ts,lib/**}`, schemas, package files, workflows, and network-security surfaces are unchanged.

The versioned `shud.contract.authority-proof.v2` registry contains exactly 55 rows. Its ordered semantic tuple projection is independently bound in both proof modules to SHA-256 `8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725`. Structural tests compile every mutation in the real `check.ts` entrypoint and reject it without loading the active preload. The independent syntax-aware topology helper parses the exact preload/control harness as data and rejects real Worker/path/FFI/child delegates outside their named helpers, wrong denial/delegate ordering, immediate global termination completion, unbounded Node/bare completion, or sentinel cleanup after route receipt. Runtime tests traverse the same registry without importing the structural scanner and deny concrete post-admission Worker/Node/Bun/FFI/child/write operations before raw delegation. Generator rows execute with `.next()` and asynchronous rows are awaited.

A bounded admission-phase Worker canary uses the same fixed fixture URL and one-argument construction as hostile rows, passes no query/environment/`workerData` fallback, and proves exact input read, sentinel write, explicit message/receipt channel, termination, and cleanup for direct global, `node:worker_threads`, and bare `worker_threads` routes. The global route registers `close` before `terminate()` and boundedly awaits the close event; Node/bare routes boundedly await promise/exit completion. Each route verifies sentinel absence before recording `termination: "close"|"exit"` and `cleanup: "complete"`. Independent raw read and FFI inversion canaries prove that raw-operation events originate beneath the exact guarded delegates; the Worker delegate records immediately before `Reflect.construct`. Every hostile row and direct success records zero raw events.

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

## Round 2 review closure

Reviewed head `9b091fbb87d30954717c5e8d208c292579a6221a` was `not-clean`: three verified P1/FIX_NOW `test-evidence` findings. Two raw inversion canaries bypassed the guarded wrappers they claimed to prove, and Worker liveness used a different configuration/transport path from hostile routes. The repair:

- moved read, FFI open/close, and Worker raw markers beneath named real-delegate helpers used by the registered wrappers;
- bound inversion canaries to the same patched public wrappers as hostile rows, with exact post-delegation denial and FFI cleanup;
- replaced query/`workerData` liveness with a fixed-URL, message-configured, same-channel Worker fixture covering global, Node, and bare routes;
- added four independent post-fix mutations that make the strengthened oracles red while preserving the named defect;
- updated OpenSpec ownership and scenarios to state the actual message transport and combined Worker oracle.

The pre-fix false greens, pinned-runtime transport diagnosis, post-fix red results, patch lengths, and SHA-256 identities are persisted in `round-2-false-green-proof.md`.

## Round 3 review closure

Reviewed head `1f969b1511f2c10b8576ac20b8ffda076e40697` was `not-clean`: five verified P1/FIX_NOW findings in task-boundary, async lifecycle, and test evidence. One separate tracked-artifact naming candidate was verified `DISCARD` because repository identity is byte content plus manifest path/hash, not a source filename claim. The repair:

- added `round-2-false-green-proof.md` to #172.C's exact tracked ownership set;
- corrected its truncated `raw-wrapper-post-fix-red.patch` SHA-256 to the independently recomputed 64-hex `538564d6d6f2e8614da6e251eb724c0a5fc12fe87408f83eee03b06af633ff12`;
- added bounded, event-backed global Worker close completion and promise-backed Node/bare termination completion before sentinel cleanup and route receipt;
- split the syntax-aware harness topology oracle into `authority-topology.ts`, independently parsing the exact preload/control sources without executing runtime;
- bound `Reflect.construct`, path/child `original.apply`, `originalDlopen`, and FFI `library.close` to named real-delegate helpers and exact denial/delegate ordering;
- added four in-memory direct-delegate bypass mutations and an immediate-global-close mutation that must fail the structural topology proof;
- updated OpenSpec ownership and scenarios to make delegate exclusivity, lifecycle completion, and cleanup ordering normative.

## Verification at repaired proof source

- Darwin Bun 1.2.19 focused proof: 12 pass / 0 fail / 495 assertions.
- Darwin Bun 1.2.19 full contracts suite: 41 pass / 0 fail / 1,462 assertions.
- Linux `oven/bun:1.2.19` read-only focused proof: 12 pass / 0 fail / 495 assertions.
- Linux `oven/bun:1.2.19` read-only full contracts suite: 41 pass / 0 fail / 1,390 assertions.
- Both public direct commands retain exit 0, empty stderr, and one exact LF-terminated receipt each:
  - `{"schema_version":"shud.git-status-capability.contract-check-receipt.v1","status":"ok","input_kind":"source_input_record"}`
  - `{"schema_version":"shud.git-status-capability.contract-check-receipt.v1","status":"ok","input_kind":"source_identity_projection"}`
- Registry deletion red proof: removing one row made both independent modules fail the frozen count oracle, expected 55 / received 54.
- Registry tuple red proof: changing the first denial operation made both modules fail the digest oracle, expected `8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725` / received `75a5bbf75e83fea9411a1a761e07e417e8936b6bde95f6415ac3fcac04b4e0f8`; exact source was restored and focused proof returned green.
- Post-fix raw read, FFI, Worker-delegate, Worker-channel, direct-delegate topology, and immediate-global-close mutations each make their strengthened oracle red; restored source returns 12 pass / 0 fail / 495 assertions in the combined focused proof.
- `npx --yes bun@1.2.19 run typecheck`: pass.
- `npx --yes bun@1.2.19 run check`: pass on the full rerun. The preceding attempt timed out only the unchanged backend Phase 6.2 proxy probe at its 3-second bound; its exact test immediately returned 1 pass / 0 fail before the full green rerun.
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-capability-observer-spike --strict`: valid.
- `git diff --check`: pass before the proof-source commit.

Fresh-worktree prerequisites only: the root installed dependency tree supplied declared `typescript@5.8.3` during tests and the pinned `zero` gitlink `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` was initialized for repository typecheck. Neither changes the PR.

## Deviations

None. No production behavior, dependency, manifest, workflow, network-security, or scientific-governance surface changed.
