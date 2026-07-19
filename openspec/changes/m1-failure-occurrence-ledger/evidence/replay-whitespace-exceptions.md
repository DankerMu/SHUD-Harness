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

Patch preflight was executed in detached temporary worktrees:

```sh
set -eu
repo_root=$(git rev-parse --show-toplevel)
replay_root=$(mktemp -d "${TMPDIR:-/tmp}/shud-ledger-replay.XXXXXX")
cleanup_replay_worktrees() {
  replay_status=$?
  trap - EXIT
  git -C "$repo_root" worktree unlock "$replay_root/round-1" >/dev/null 2>&1 || true
  git -C "$repo_root" worktree unlock "$replay_root/round-2" >/dev/null 2>&1 || true
  git -C "$repo_root" worktree remove --force "$replay_root/round-1" >/dev/null 2>&1 || true
  git -C "$repo_root" worktree remove --force "$replay_root/round-2" >/dev/null 2>&1 || true
  rmdir "$replay_root" >/dev/null 2>&1 || true
  exit "$replay_status"
}
trap cleanup_replay_worktrees EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$repo_root" worktree add --detach "$replay_root/round-1" \
  a370f8e3a510b34c47d642f10f7d095aa8bb4b26
git -C "$replay_root/round-1" apply --check \
  "$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-1/phase-6.2/red-before-tests.patch"

git -C "$repo_root" worktree add --detach "$replay_root/round-2" \
  b425a68aa6e3f886c424d439f48bb97ac05bac23
git -C "$replay_root/round-2" apply --check \
  "$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/red-before-backend-undefined.patch"

git -C "$repo_root" worktree remove "$replay_root/round-1"
git -C "$repo_root" worktree remove "$replay_root/round-2"
rmdir "$replay_root"
trap - EXIT HUP INT TERM
```

The complete block was copied from this tracked file and executed from the
repository root: both `git apply --check` commands exited 0, both temporary
worktrees were removed, and the temporary root no longer existed. Patch-check
failure and locked-worktree cleanup probes each returned nonzero; the EXIT trap
then unlocked and force-removed their temporary worktrees without residue. A clean
incremental A3 `git diff --check` must exit 0 because A3 introduces no new
whitespace exception.
