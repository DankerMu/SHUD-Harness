# Issue #87 Child A — Round 1 Invariant Closure Evidence

Implementation baseline: `2656ea0945aa64dde9b4ac4d1e7255d1a485dcd4`

Verified production implementation head: `bd9e776080b9fa23314e268a37048a41a5b6c8ea`. Verified final test-oracle head: `2ebae919738a46aa597b60983d4ee98316c92c41`. Any evidence-only descendant MUST retain the production hashes from `bd9e776` and the final contract-test hash recorded below.

Platform for semantic-red replay: macOS 15.6 (`24G84`), Bun 1.2.19

Contract amendment: user-approved cooperative-writer serialization; no hostile-writer pathname CAS claim.

## Implemented closure

- Branded held mutation capability is constructible only after exclusive nonblocking `flock` on the opened `secrets` directory and identity reproof.
- Recovery, publication, rollback, creation, move, retirement, and cleanup require the held capability instead of a bare mutation descriptor.
- Mutation helpers keep explicit precondition tamper checks and postcondition validation; names/comments do not claim source-inode-conditioned rename/unlink.
- Workspace leaf and `secrets` creation use one final-name no-clobber `mkdirat(0700)` after an absent observation. A cooperative collision fails the current call; an independent retry validates the winner. No random directory-staging namespace exists.
- Descriptor ownership transfer, lease unlock/close, and multi-resource settlement close every acquired resource before propagating failure.
- Token reads share one real-Header-safe grammar: 1–4096 bytes of visible ASCII (`0x21`–`0x7e`) excluding comma; control, whitespace, DEL, non-ASCII, NUL, malformed UTF-8 and oversize input fail closed without overwrite.
- Inventory filters dot records before decoded-entry accounting and applies an independent 4096 raw-record work ceiling.
- Crash after rollback-marker fsync, process death after either final-name bootstrap mkdir, absent-tree cooperative contention at both directory surfaces, same-inode rewrite, relative root, close failure, Darwin/Linux dot order/work bounds, and cooperative cross-process exclusion have direct regression tests.
- `scripts/local-auth/adversarial-matrix.ts` gives the complete local-auth matrix one external 30-second process-group deadline; test subprocess cases retain two-second ceilings.

No routes, listener, readiness, deny-root, core, frontend, perf wiring, Child B, or M3+ production behavior changed.

## Source-bound semantic red

All mutations were applied separately to the final relevant source, run red, reverted immediately, and rerun green. Mutations 2 and 3 target files unchanged by the later bootstrap redesign. Mutation 1 was replayed once more after the final-name bootstrap correction and restored to the exact final source hash.

### 1. Cooperative mutation-lock authorization

Pre-mutation SHA-256:

- `packages/backend/src/local-auth/local-token-filesystem.ts`: `67a3d47da5713f886d93d8e7340ac5b6ac36c3d8567e88cfb227ba085536c461`
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

Mutated production SHA-256: `ec41a28482298cbc7428a11fa71ac8e64ca5bfe36e018d26ffc1f1cea5719839`.

Command:

```sh
npx --yes bun@1.2.19 test packages/backend/src/local-auth/local-token-store.transaction.test.ts -t "cross-process cooperative writer"
```

Red result: exit 1; 0 pass, 1 fail, 15 filtered, 1 assertion. The public writer returned `success` instead of `blocked` while another process held the directory mutation lock, proving the public mutation path depends on successful lock authorization.

After immediate restoration the production hash returned to `67a3d47da5713f886d93d8e7340ac5b6ac36c3d8567e88cfb227ba085536c461`; the same command was green with 1 pass, 0 fail, 15 filtered, 6 assertions. The source diff hash was identical before and after replay: `5e4557dbf1b44871e7d0115bcde7198bacf108be9878192224130e88a7ec3fe1`.

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

## Round 2 verified invariant closure

Round 2 independently confirmed three behavioral gaps plus one evidence-bookkeeping gap on `3f1b76980f727413782e9ac623e029ff020663cf`; the `O_CLOEXEC` candidate was independently REFUTED as unreachable in this unwired synchronous Child A fixture and was not implemented.

The behavioral RED used the final Round 2 tests with the pre-fix production files from `3f1b769`:

- pre-fix `local-token-filesystem.ts`: `67a3d47da5713f886d93d8e7340ac5b6ac36c3d8567e88cfb227ba085536c461`
- pre-fix `local-token-transaction.ts`: `2298e9d2b9c718b4aac2bd5f848584e91eeb293adeef55731bf89bf14ec37c81`

Command:

```sh
npx --yes bun@1.2.19 test \
  packages/backend/src/local-auth/local-token-store.contract.test.ts \
  packages/backend/src/local-auth/local-token-store.transaction.test.ts \
  -t 'live no-clobber collision|publishing recovery preserves a foreign canonical but fails|rolling-back recovery restores a foreign candidate|rolling-back recovery preserves a foreign canonical but fails|rejects non-ByteString|restrictive owner-bit umask'
```

Red result: exit 1; 0 pass, 8 fail, 53 filtered, 0 errors. U+0100/emoji failed because real `Headers` threw while storage returned authority; both restrictive-umask surfaces left final directories; live collision plus publishing/rolling-back recovery returned foreign authority. There was no missing hook, timeout, collection failure, or unrelated failure. After production restoration/fix, the identical command passed 8/8 with 54 filtered and 37 assertions.

Implemented closure:

- Live no-clobber collision preserves the foreign canonical, cleans only identity-proven owned protocol state, and fails the current invocation; an independent retry validates/reuses the stable winner.
- Publishing and rolling-back recovery remember any foreign generation they preserve/restore and fail that recovery invocation after bounded cleanup. Tests cover foreign publishing canonical, rolling-back candidate restoration, and rolling-back foreign canonical.
- Workspace-leaf and `secrets` bootstrap inspect effective `0700 & ~umask` plus parent setgid before `mkdirat`; a mode-transforming environment fails before mutation with no final residue and never chmods a collision winner.
- Token validation is explicitly visible ASCII and tests use real Bun 1.2.19 `Headers` plus `Request`; U+0100, emoji, Latin-1, C0, DEL, whitespace, comma and NUL are rejected while generated tokens and the 4096-byte ASCII boundary round-trip.

Final production SHA-256 at `bd9e776080b9fa23314e268a37048a41a5b6c8ea`; unchanged tests also retain these hashes, except the contract test superseded at `2ebae919738a46aa597b60983d4ee98316c92c41`:

- `local-token-filesystem.ts`: `4e68e925983bf9f756de8a8ea71ad94e5b0f30cf252c3dbf39963d081c87728c`
- `local-token-transaction.ts`: `221c348066469e25a298576a956eae83c23c12bdddfa77e79b619a76e96cf9de`
- `local-token-syscalls.ts`: `4b6840c5422e724420fb3e4a46db8f496b396a350de72574e32b35b3e61c7a65`
- `local-token-store.ts`: `f69739d9f3b4d6d3440beb22d7873cad68dd95ba25d1839fa9ddf9b3f267988b`
- `local-token-types.ts`: `2b7bb7bc2a48ea81258be277f8ec4df07f8b6780acb7e09804558e5d2112db07`
- `local-token-inventory.ts`: `b8f53263ce5e01db1de4cc50b9bfdbc7fc60cd654cf386e5aacf9a673d20fe4e`
- `local-token-test-support.ts`: `de96a359274358a6daebec699a29eded4f7c302a3dfd915f877b203856762296`
- `local-token-test-helpers.ts`: `ae6c041d04747ac93a66824559dcb307241b164ce34bbb37447f465e4a493864`
- `local-token-store.contract.test.ts`: `724f3cea06a4315825655991249a2c0a37dfba18029aad51155132bba747105f`
- `local-token-store.transaction.test.ts`: `d08b5f3be972e15532b85da194433a433e8197944bf5932d0418c6977b384279`
- `local-token-store.inventory.test.ts`: `d58541830bb60dd087ca8e582aee81d86030ccb7b75cefec86cc7560c6242d86`
- `local-token-store.lifecycle.test.ts`: `9f8ae9688ae9d02b9e85ac0d2a51481f9c42b125e99d571852d842f41d5d6e7b`

## Phase 6.2 cooperative bootstrap redesign

The first invariant audit initially selected UUID directory staging to avoid adopting a final-name collision. Re-audit showed that randomness did not establish an unforgeable identity: an active parent writer could move the same pre-open race to the staging name, while ordinary process death after staging `mkdirat` left an undiscoverable, unbounded directory residue. The persisted same-invariant depth retro therefore replaced that protocol with a user-approved cooperative bootstrap boundary.

The final implementation performs one no-clobber `mkdirat(0700)` on the workspace-leaf / `secrets` final name after observing absence. Any collision fails the current call; an independent retry validates the winner. After successful mkdir it opens, validates, fsyncs, and rebinds the final name. It never chmods, renames, removes, or stages a bootstrap directory. Process death can leave only the bounded final private directory, which restart validates and resumes. Token/protocol mutations after `secrets` exists remain authorized exclusively by the branded held mutation lease.

Corrected source-bound red command, with only the final production filesystem/syscall edits stashed back to c20 while the final public-seam tests remained:

```sh
npx --yes bun@1.2.19 test packages/backend/src/local-auth/local-token-store.contract.test.ts -t 'cooperative workspace-leaf creators|cooperative secrets creators|restart converges after process death at the final workspace-leaf mkdir|restart converges after process death at the final secrets mkdir'
```

Production SHA-256 before stash and after immediate restoration:

- `local-token-filesystem.ts`: `67a3d47da5713f886d93d8e7340ac5b6ac36c3d8567e88cfb227ba085536c461`
- `local-token-syscalls.ts`: `4b6840c5422e724420fb3e4a46db8f496b396a350de72574e32b35b3e61c7a65`
- combined production diff: `602978e9f89dc41628110519187453a022ab466d25ba24781dfc2933695cd044`

The stashed c20 source hashes were `4994902adfca30a61560efabf2b64482fd6cd70e63088f5e4229e0c9742d77bd` and `3da6e548eb239913f708df2f31c070673b4730df4a6d51019b0f0ffe341cd292`. Red result: exit 1; 0 pass, 4 fail, 30 filtered, 4 assertions. Before releasing either contention barrier, the tests observed two UUID staging entries at the relevant parent. Each SIGKILL case observed one UUID staging entry and failed its first explicit no-residue assertion. No timeout, missing-hook, or collection failure contributed to the red result.

After immediate restoration the identical command passed 4/4 with 38 assertions. Both contention surfaces produce exactly one successful public call and one stable `LocalTokenStorageError`, never overwrite/rename the final directory, and let the loser independently retry the winner's exact canonical token. Both process-death surfaces retain the same final directory `(dev, ino)`, restart to one canonical authority, and leave no random directory-staging residue.

Phase 6.2 direct-test SHA-256 at `3f1b769` (historical; superseded by the Round 2 final hashes above):

- `local-token-test-support.ts`: `de96a359274358a6daebec699a29eded4f7c302a3dfd915f877b203856762296`
- `local-token-test-helpers.ts`: `4983a7d2957fb525b2d64d628b3809a82a536e0a04d603a152c09a4eca9d6f1c`
- `local-token-store.contract.test.ts`: `964c58d9e65ed2e1f7c71cff6fbcaae4119b146e95039e91a42d6dcc32db0c41`

## Final green verification

Round 3 exposed two test-oracle gaps without a production regression. In the exact Linux container, the former setgid rows reported 2 pass but zero assertions because Bun `chmodSync(02700)` left mode `0700` and the tests returned early. The corrected tracked tests are Linux-only with explicit skips elsewhere, use `/bin/chmod 2700`, assert directory/uid/gid/mode before invoking the public seam, and then assert `LocalTokenStorageError` plus zero final residue at both surfaces. A second tracked fixture constructs every byte `0x21`–`0x7e` except comma (93 bytes) and proves storage plus real `Headers`→`Request` round-trip. Targeted Linux result at `2ebae919738a46aa597b60983d4ee98316c92c41`: 3 pass, 0 fail, 16 assertions.

All final verification below ran at committed final test-oracle head `2ebae919738a46aa597b60983d4ee98316c92c41` before this evidence-only update; production files remain byte-identical to `bd9e776080b9fa23314e268a37048a41a5b6c8ea`.

macOS command:

```sh
npx --yes bun@1.2.19 run test:local-auth:adversarial
```

Result: exit 0; 92 pass, 2 explicit Linux-only skips, 0 fail, 388 assertions.

Linux command (the first attempt used `git` inside the image and failed before tests because the minimal image has no `git`; this corrected command uses Bun to read the mounted ref and is the recorded green run):

```sh
docker run --rm \
  --user 65532:65532 \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 \
  -v "$PWD:/work:ro" \
  -w /work \
  oven/bun:1.2.19 \
  sh -lc 'bun -e '\''const head=(await Bun.file(".git/HEAD").text()).trim(); const ref=head.startsWith("ref: ") ? head.slice(5) : null; console.log(ref ? (await Bun.file(`.git/${ref}`).text()).trim() : head)'\'' && sha256sum packages/backend/src/local-auth/local-token-store.contract.test.ts && bun scripts/local-auth/adversarial-matrix.ts'
```

Result: exit 0; container printed head `2ebae919738a46aa597b60983d4ee98316c92c41`, printed contract-test hash `724f3cea06a4315825655991249a2c0a37dfba18029aad51155132bba747105f`, then 94 pass, 0 skip, 0 fail, 400 assertions as UID/GID 65532 with a read-only repository mount and tmpfs `/tmp`. Both Linux setgid rows executed their store path and contributed assertions.

- `bun run test:backend-api`: exit 0; route suites and externally bounded local-auth matrix passed.
- `bun run typecheck`: exit 0.
- `bun run check`: exit 0 on orchestrator rerun.
- `bun run test:perf:api`: exit 0; P95 tasks 0.07 ms, detail 0.01 ms, ready 10.32 ms, each below 300 ms.
- `openspec validate m2-research-context --strict --no-interactive`: valid.
- `git diff --check`, submodule/workspace/package/lock/stash/debug hygiene: clean.

Deviations: the hostile same-directory writer promise was replaced by the user-approved cooperative-writer capability boundary after confirming Darwin/Linux lack source-inode-conditioned namespace mutation. The first Phase 6.2 UUID directory-staging correction was superseded by the persisted same-invariant depth retro because it introduced unbounded crash residue; the final fixture and implementation use cooperative final-name bootstrap with creation-mode preflight. The accepted token language was narrowed from general UTF-8 to visible ASCII because the frozen real browser Header seam rejects non-ByteString Unicode and Latin-1 behavior was not stable enough to preserve as a cross-platform contract. The requested local-auth matrix alias did not exist, so verification used the repository's canonical `test:local-auth:adversarial` entry. No Child B/M3+ scope changed.
