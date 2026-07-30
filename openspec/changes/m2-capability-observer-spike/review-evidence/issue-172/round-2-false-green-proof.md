# PR #174 Round 2 false-green proof

Base/head before tracked repair: `9b091fbb87d30954717c5e8d208c292579a6221a`.
Runtime: Darwin, Bun `1.2.19` (`aad3abea`).
Focused command: `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests/authority-runtime.test.ts`.

## Raw guarded-delegate oracle

Patch: `.workplans/pr-174/diagnosis/raw-wrapper-false-green.patch`
Length: 1,936 bytes
SHA-256: `3d4dc0500c6307836092ed54466b4fd58787d9c6843474b609d5f956d881b2b6`

The mutation makes the real registered `node_fs.readFileSync` wrapper perform its original read before the same throwing denial while leaving the wrapper raw marker unreachable. It also makes the real guarded FFI `dlopen` execute before denial and closes the returned library in `finally`, again without reaching the wrapper raw marker. Expected denial payloads, replacement bytes, and sentinels are unchanged.

Observed result after applying the patch: exit `0`; `5 pass`, `0 fail`, `359 expect() calls`. This is the reproduced false green: both forbidden delegates executed, but the current proof still reported green with empty raw events. The patch was reversed immediately; tracked source returned to HEAD.

## Worker transport/channel oracle

Patch: `.workplans/pr-174/diagnosis/worker-channel-false-green.patch`
Length: 3,335 bytes
SHA-256: `26191bbbf91b7c6176590cd3d31c2be3004dc08e6a4f0bd21a63cf7ca0ee203c`

The mutation makes the positive Node liveness fixture prefer its extra `workerData`, while the direct global query-only hostile path actually constructs the original Worker. That Worker enters the fixture and deterministically fails before sentinel creation because it has no `workerData`; the proxy observes the worker error, records the same `global_worker:` event, and synchronously emits the same expected denial error. No test expectations change.

Observed result after applying the patch: exit `0`; `5 pass`, `0 fail`, `359 expect() calls`. This is the reproduced false green: a query-only hostile Worker realm was started but the existing absent-sentinel oracle and fallback-backed liveness canary still certified the row. The patch was reversed immediately; tracked source returned to HEAD.

## Pinned-runtime transport diagnosis

The first exact-path repair attempts exposed three Bun 1.2.19 constraints under the same focused red loop:

1. a global Worker strips file-URL query parameters before `import.meta.url`;
2. a global Worker does not inherit parent `process.env` mutations; and
3. its message events are not dispatched while module evaluation is suspended on a top-level await for configuration.

A minimal ignored probe confirmed that the Bun global Worker has both global `postMessage` and `parentPort`, while parent `worker.postMessage` reaches the global handler. The final fixture therefore uses a fixed URL, completes module evaluation after installing handlers, and uses a parent-driven bounded probe/retry handshake. The matching handler receives one configuration message and replies on the same explicit `global` or `parent_port` channel. There is no query, environment, or `workerData` fallback.

## Post-fix mutation proof

All patches below were applied independently to the fixed tree, followed by the same focused runtime command, then reversed immediately:

- `raw-wrapper-post-fix-red.patch`: 891 bytes; SHA-256 `538564d6d6f2e8614da6e251eb724c0a5fc12fe87408f83eee03b06af633ff`. Result: exit `1`; the `node_fs_readFileSync` row retained the exact denial but reported `raw:node_fs_readFileSync:[replacement-path]`.
- `raw-ffi-post-fix-red.patch`: 1,018 bytes; SHA-256 `094254aabddd7d532d49dce5d7e227abb3b4b4ed31ab36ca9eae73826a0f09e4`. Result: exit `1`; the `ffi_dlopen` row retained the exact denial but reported `raw:ffi_dlopen:[system-library]` and `raw:ffi_close:[system-library]`.
- `worker-delegate-post-fix-red.patch`: 1,167 bytes; SHA-256 `16e6dbbfcfb207d6217bdf0c5a15a61b6724b004523b098f4c25d666e8220a2e`. Result: exit `1`; the `global_worker` row retained the exact denial but reported `raw:global_worker:`.
- `worker-channel-post-fix-red.patch`: 786 bytes; SHA-256 `72116d66acd81f41e994a55ee1ab90d046fb4813a445b644b95f88bbc6e8c2f8`. Result: exit `1`; the positive global liveness canary failed before the hostile matrix when its explicit global handler was broken.

Restored normal source then returned `5 pass / 0 fail / 359 assertions`; the combined structural/runtime command returned `8 / 0 / 488`. Darwin full contracts returned `37 / 0 / 1,455`; Linux Bun 1.2.19 returned focused `8 / 0 / 488` and full `37 / 0 / 1,407`.

The repaired proof now binds raw read/FFI/Worker events to the exact real delegate helpers and binds Worker liveness to the same fixed URL, construction shape, configuration message, and receipt channel used by hostile routes. Synchronous deny before configuration is covered by the zero-raw Worker oracle rather than by an absent sentinel alone.
