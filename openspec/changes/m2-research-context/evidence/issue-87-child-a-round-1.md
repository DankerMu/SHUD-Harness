# Issue #87 Child A — Round 1 Invariant Closure Evidence

Implementation baseline: `2656ea0945aa64dde9b4ac4d1e7255d1a485dcd4`

Platform for semantic-red replay: macOS 15.6 (`24G84`), Bun 1.2.19

Contract amendment: user-approved cooperative-writer serialization; no hostile-writer pathname CAS claim.

## Implemented closure

- Branded held mutation capability is constructible only after exclusive nonblocking `flock` on the opened `secrets` directory and identity reproof.
- Recovery, publication, rollback, creation, move, retirement, and cleanup require the held capability instead of a bare mutation descriptor.
- Mutation helpers keep explicit precondition tamper checks and postcondition validation; names/comments do not claim source-inode-conditioned rename/unlink.
- Workspace leaf and `secrets` creation publish an opened, validated, identity-captured private staging directory to the final name with no-replace rename. A final-name collision fails the current call without adopting it; an independent retry may validate the now-existing directory.
- Descriptor ownership transfer, lease unlock/close, and multi-resource settlement close every acquired resource before propagating failure.
- Token reads share one transport-safe grammar: nonempty byte-preserving UTF-8, at most 4096 bytes, no whitespace/comma/NUL.
- Inventory filters dot records before decoded-entry accounting and applies an independent 4096 raw-record work ceiling.
- Crash after rollback-marker fsync, same-inode rewrite, relative root, first-create replacement, close failure, Darwin/Linux dot order/work bounds, and cooperative cross-process exclusion have direct regression tests.
- `scripts/local-auth/adversarial-matrix.ts` gives the complete local-auth matrix one external 30-second process-group deadline; test subprocess cases retain two-second ceilings.

No routes, listener, readiness, deny-root, core, frontend, perf wiring, Child B, or M3+ production behavior changed.

## Source-bound semantic red

All mutations were applied separately to the final relevant source, run red, reverted immediately, and rerun green. Mutations 2 and 3 target files unchanged by the later first-create closure; mutation 1 was replayed again after that closure. Its final local-auth diff SHA-256 was identical before and after replay: `547a008b52fe6d7fa0afa312d4dc8635bef35c7cadd73d5466746eb7285cd673`.

### 1. Cooperative mutation-lock authorization

Pre-mutation SHA-256:

- `packages/backend/src/local-auth/local-token-filesystem.ts`: `4994902adfca30a61560efabf2b64482fd6cd70e63088f5e4229e0c9742d77bd`
- `packages/backend/src/local-auth/local-token-store.transaction.test.ts`: `8c5280785adbdf69fe30fba76d44e10e0618999f5a143951cb694e2104fb06a4`

Applied production mutation:

```diff
-  if (
-    flockNonblocking(
-      descriptors.secrets,
-      FLOCK_EXCLUSIVE | FLOCK_NONBLOCKING
-    ) !== 0
-  ) {
-    throw unsafeLocalTokenStorageError();
-  }
+  flockNonblocking(
+    descriptors.secrets,
+    FLOCK_EXCLUSIVE | FLOCK_NONBLOCKING
+  );
```

Mutated production SHA-256: `dc1b85116d80d03025dec4d481dc651a8e97c0edbaf81b50a1e5ce89f2a0a949`.

Command:

```sh
npx --yes bun@1.2.19 test packages/backend/src/local-auth/local-token-store.transaction.test.ts -t "cross-process cooperative writer"
```

Red result: exit 1; 0 pass, 1 fail, 15 filtered, 1 assertion. The public writer returned `success` instead of `blocked` while another process held the directory mutation lock, proving the public mutation path depends on successful lock authorization.

After immediate restoration the production hash returned to `4994902adfca30a61560efabf2b64482fd6cd70e63088f5e4229e0c9742d77bd`; the same command was green with 1 pass, 0 fail, 15 filtered, 6 assertions.

### 2. Stable `1024 external + 8 owned` accounting

Pre-mutation SHA-256:

- `packages/backend/src/local-auth/local-token-types.ts`: `2b7bb7bc2a48ea81258be277f8ec4df07f8b6780acb7e09804558e5d2112db07`
- `packages/backend/src/local-auth/local-token-store.inventory.test.ts`: `d58541830bb60dd087ca8e582aee81d86030ccb7b75cefec86cc7560c6242d86`

Applied production mutation:

```diff
 export const LOCAL_TOKEN_MAX_DECODED_ENTRIES =
-  LOCAL_TOKEN_MAX_EXTERNAL_ENTRIES + LOCAL_TOKEN_MAX_OWNED_ENTRIES;
+  LOCAL_TOKEN_MAX_EXTERNAL_ENTRIES;
```

Mutated production SHA-256: `a619e985a392c26c5ea73fe4c5e819dda387d25c1b2ba3ee7b0faf33719cb467`.

Command:

```sh
npx --yes bun@1.2.19 test packages/backend/src/local-auth/local-token-store.inventory.test.ts -t "1024 external entries"
```

Red result: exit 1; 0 pass, 4 fail, 15 filtered, 6 assertions. Ordinary restart plus staged, publishing, and rolling-back recovery each rejected because the legacy total limit incorrectly charged module-owned protocol entries to the external budget.

After immediate restoration the production hash returned to `2b7bb7bc2a48ea81258be277f8ec4df07f8b6780acb7e09804558e5d2112db07`; the same command was green with 4 pass, 0 fail, 15 filtered, 22 assertions.

### 3. Immediate descriptor ownership

Pre-mutation SHA-256:

- `packages/backend/src/local-auth/local-token-transaction.ts`: `2298e9d2b9c718b4aac2bd5f848584e91eeb293adeef55731bf89bf14ec37c81`
- `packages/backend/src/local-auth/local-token-store.lifecycle.test.ts`: `9f8ae9688ae9d02b9e85ac0d2a51481f9c42b125e99d571852d842f41d5d6e7b`

Applied production mutation:

```diff
-    stagedDescriptor = shouldFailLocalTokenTestOperation("staged_open")
+    const openedStagedDescriptor = shouldFailLocalTokenTestOperation("staged_open")
       ? -1
       : openCreatedArtifactUnderLease(mutationLease, stagedName);
-    if (stagedDescriptor < 0) {
-      stagedDescriptor = undefined;
+    if (openedStagedDescriptor < 0) {
       leaseExists = false;
       leaseDescriptorOpen = false;
-      settleOperations(
-        () => closeOwnedDescriptor(lease.descriptor),
-        () => cleanupControl(mutationLease, lease.control)
-      );
+      cleanupControl(mutationLease, lease.control);
+      closeOwnedDescriptor(lease.descriptor);
       throw unsafeLocalTokenStorageError();
     }
     stagedExists = true;
     if (shouldFailLocalTokenTestOperation("staged_fstat")) {
       throw unsafeLocalTokenStorageError();
     }
+    stagedDescriptor = openedStagedDescriptor;
```

Mutated production SHA-256: `9e6696ec1e538522a0a9ab7cc9d28bc3e60f401ad90f898607f0cf3cfb8c0e7e`.

Command:

```sh
npx --yes bun@1.2.19 test packages/backend/src/local-auth/local-token-store.lifecycle.test.ts -t "staged (open|fstat) failure closes"
```

Red result: exit 1; 0 pass, 2 fail, 10 filtered, 11 assertions. The staged-open cleanup mismatch lost the lease descriptor before a possibly failing cleanup; the staged-fstat failure occurred before the opened staged descriptor entered managed ownership. Both tests observed one descriptor above baseline.

After immediate restoration the production hash returned to `2298e9d2b9c718b4aac2bd5f848584e91eeb293adeef55731bf89bf14ec37c81`; the same command was green with 2 pass, 0 fail, 10 filtered, 33 assertions.

The pre-mutation replacement cases are coverage for observable tamper rejection only and are not attributed as pathname CAS evidence.

## Phase 6.2 first-create closure

The invariant audit showed that removing stale pathname chmod was insufficient: the final-name directory could still change in `mkdirat -> first open`, then be captured as if it were the created generation. The final protocol now creates a UUID-named private staging directory under the held parent, opens and validates that staging inode, publishes it to the final name by no-replace rename, and rebinds the final name to the captured identity. A final-name collision cleans only the captured empty staging directory and fails the current call; it is never adopted in that call.

Red command against the pre-fix final-name mkdir behavior with the exact post-staging-mkdir/pre-first-open seams and tests present:

```sh
npx --yes bun@1.2.19 test packages/backend/src/local-auth/local-token-store.contract.test.ts -t "post-staging .* collision"
```

Pre-fix SHA-256:

- `local-token-filesystem.ts`: `a6f02f51b8a56efdedc870a9c57f120bf944b49e956e74fe8d2b3fe47309611b`
- `local-token-store.contract.test.ts`: `8a1dca2cb9673aa5afeb37d1bd7daf9dd1a3b223606bb677b62d9c1d640da40b`
- `local-token-test-support.ts`: `0fe984603ff3a24b927c7205a7bc58832b67be67c469c15fc5ae5f4158004ff0`

Red result: exit 1; 0 pass, 2 fail, 30 filtered, 2 assertions. Both workspace-leaf and `secrets` tests observed no exception because the old final-name mkdir path opened and adopted the newly appeared private `0700` final directory, then continued to authority publication.

Green result after the staging-directory protocol: exit 0; 2 pass, 0 fail, 30 filtered, 20 assertions. Both surfaces return `LocalTokenStorageError` for the collision call, preserve replacement inode/mode/sentinel, create no token/protocol entry there, leave no staging residue, and allow a later independent retry to validate and use the existing private directory.

Final SHA-256:

- `local-token-filesystem.ts`: `4994902adfca30a61560efabf2b64482fd6cd70e63088f5e4229e0c9742d77bd`
- `local-token-syscalls.ts`: `3da6e548eb239913f708df2f31c070673b4730df4a6d51019b0f0ffe341cd292`
- `local-token-store.contract.test.ts`: `8a1dca2cb9673aa5afeb37d1bd7daf9dd1a3b223606bb677b62d9c1d640da40b`
- `local-token-test-support.ts`: `0fe984603ff3a24b927c7205a7bc58832b67be67c469c15fc5ae5f4158004ff0`

## Final green verification

- macOS Bun 1.2.19 local-auth adversarial matrix: 79 pass, 0 fail, 322 assertions.
- Linux `oven/bun:1.2.19`, UID/GID 65532, read-only repository mount: 79 pass, 0 fail, 322 assertions.
- `bun run test:backend-api`: exit 0; route suites and externally bounded local-auth matrix passed.
- `bun run typecheck`: exit 0.
- `bun run check`: exit 0 on orchestrator rerun.
- `bun run test:perf:api`: exit 0; P95 tasks 0.09 ms, detail 0.01 ms, ready 12.46 ms, each below 300 ms.
- `openspec validate m2-research-context --strict --no-interactive`: valid.
- `git diff --check`, submodule/workspace/package/lock/stash/debug hygiene: clean.

Deviation: the hostile same-directory writer promise was replaced by the user-approved cooperative-writer capability boundary after confirming Darwin/Linux lack source-inode-conditioned namespace mutation. No other deviation.
