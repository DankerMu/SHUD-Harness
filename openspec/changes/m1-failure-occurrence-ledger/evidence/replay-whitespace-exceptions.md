# Replay-patch whitespace exceptions

TE-R3-01 permits exactly 13 byte-preserving trailing-space findings inside two
tracked unified-diff replay artifacts. Each listed artifact line contains one
space as the unified-diff blank context marker; an outer Git diff renders it as
`+ `. Removing that byte changes the replay artifact and its SHA-256.

## Round 1 Phase 6.2: seven lines

Artifact:
`evidence/repair-round-1/phase-6.2/red-before-tests.patch`

Lines: 30, 128, 183, 256, 312, 317, and 556.

SHA-256:
`b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`.

Replay base: `a370f8e3a510b34c47d642f10f7d095aa8bb4b26`.

## Round 2 backend: six lines

Artifact:
`evidence/repair-round-2/red-before-backend-undefined.patch`

Lines: 51, 68, 160, 205, 209, and 376.

SHA-256:
`a5e3db535e3b4a40fd2606f4bbda8a0f13860ed3bf7294dad7951669808c68e9`.

Replay base: `b425a68aa6e3f886c424d439f48bb97ac05bac23`.

## Fresh-clone verification

From a fresh clone at the A3 evidence head:

```sh
git show HEAD:openspec/changes/m1-failure-occurrence-ledger/evidence/phase-6.2-definitive-audit.md >/dev/null
git diff --check 5a450a97f2a474af2f4db26bd9ee198adb7395ec..HEAD
rg -n '[[:blank:]]+$' openspec/changes/m1-failure-occurrence-ledger/evidence -g '*.patch'
shasum -a 256 openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-1/phase-6.2/red-before-tests.patch openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/red-before-backend-undefined.patch
```

Expected results:

- the tracked audit resolves;
- range-wide `git diff --check` exits 2 with exactly these 13 findings and no
  product/spec/test/other-evidence finding;
- `rg` returns exactly the seven plus six lines above;
- hashes match the two values above.

The canonical replay verifier and its deterministic lifecycle fault matrix are
tracked beside this report:

```sh
./openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.sh
./openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.test.sh
```

The verifier exited 0 after both `git apply --check` commands and strict cleanup.
It pre-binds one exact per-process root, rejects a pre-existing target without
touching it, and installs EXIT/HUP/INT/TERM authority before creating that root.
Signal and EXIT handlers receive an already-expanded status and mask later
signals as their first command.

The self-test passed 22/22 normal, root-creation failure, add/patch/partial,
dirty/locked/missing cleanup, single-signal, cleanup-entry double-signal,
first-failure preservation, verifier/harness collision, harness-startup signal,
and harness cleanup-entry double-signal scenarios. Every case retained its
required first status and left no registered worktree or owned temporary root;
the collision cases also proved that the foreign targets remained unchanged. A clean
incremental A3 `git diff --check` must exit 0 because A3 introduces no new
whitespace exception.
