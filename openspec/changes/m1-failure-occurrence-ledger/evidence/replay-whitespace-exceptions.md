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
tracked beside this report. Both source the same POSIX lifecycle authority:

```sh
shellcheck -s sh openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/*.sh
./openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.sh
./openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.test.sh
```

The verifier exited 0 after both `git apply --check` commands and strict cleanup.
`replay-lifecycle.sh` atomically acquires a fixed claim symlink whose value is a
per-invocation token. Before spawning the creation child, the parent performs a
signal-capable first read, masks handled lifecycle signals, and reconciles the
current exact token with one authoritative retry. It records claim ownership
only on that exact match, never removes a mismatch, and propagates any
pre-existing latch after ownership is knowable. One short child transaction
ignores HUP/INT/TERM, wins or loses atomic `mkdir`, and publishes the same token
inside the root only after its own `mkdir` succeeds. Every parent path after
child spawn converges on one settlement boundary: it publishes the release
barrier when possible, otherwise force-reaps the child. When an outcome is
published while the creation child remains live, the parent reads, classifies,
and latches it before wait/reap. Handler adoption and ordinary settlement use
one atomic decode-and-commit boundary that distinguishes no publication, exact
token zero, collision 73, and protocol/read failures mapped to 67.
`decode_active` remains asserted while the boundary latches the decoded result
and then the first deferred event; only after both steps can a handler attempt
another adoption. This closes all three read/commit windows without changing
event-before-publication order.
As soon as a non-zero release or outcome result is determined, the parent
records it in the shared write-once latch before later settlement, ownership
reconciliation, or transaction cleanup; an earlier signal already in the
latch remains first.
The parent accepts ownership only when child success, claim token, and root
token all agree. A same-name or non-cooperating loser returns 73 without
publishing a marker or touching the target; a pre-existing foreign target
remains byte-for-byte unchanged. EXIT cleanup masks EXIT/HUP/INT/TERM as its
first command, then preserves the write-once first status across later signals
and cleanup diagnostics. Successful finalization masks HUP/INT/TERM while
keeping EXIT cleanup armed, then immediately exits through that cleanup when
the same write-once latch is already set; strict teardown only begins from a
clear latch.

The self-test passed 66/66 named scenarios. Nineteen are two-party races with
38 explicit participant outcomes:

- 18 baseline verifier scenarios: normal, post-create failure, two add failures,
  two patch failures, two partial states, dirty/locked/missing strict cleanup,
  three post-root signals, three ordered double signals, and failure-before-
  cleanup signal;
- seven cleanup-diagnostic variants of the controlled add/patch/dirty/locked/
  missing failures. Their exact protocol statuses are 74, 75, 76, 78, 79, 80,
  and 81; an injected cleanup diagnostic with status 77 never replaces them;
- two static foreign-target collisions, verifier and harness cooperative
  same-name atomic races, verifier and harness non-cooperating actor races, and
  the two prior harness startup/double-signal paths;
- verifier and harness TERM plus verifier HUP→INT while each child is held
  after normal work and before strict successful teardown; the held child
  returns 143, 143, and 129 respectively and both participants leave no
  residue;
- HUP, INT, TERM, HUP→INT, INT→TERM, and TERM→HUP delivered to an isolated
  process group while the external root-creation child is live;
- TERM delivered by a failing published-outcome read is deferred behind the
  decoder's protocol status 67 after reconciling committed ownership, while
  injected release-publication failure likewise preserves transaction status
  67 after force-reaping the unreleased child;
- verifier and harness chronology probes preserve release failure 67 and a
  published collision outcome 73 when TERM arrives only after that result is
  determined; the collision child remains held until the parent has classified
  73, delivered TERM, and released it;
- verifier and harness unknown-outcome probes map the published protocol value
  to 67 before the same held-child TERM/release sequence; all six chronology
  probes prove that the earlier transaction result wins and every owned/probe
  artifact is removed;
- verifier and harness readlink-window probes preserve already-published
  collision 73 and unknown-protocol 67 when TERM enters the handler before the
  ordinary parent read has classified that link; paired TERM-before-publication
  controls remain 143;
- verifier and harness handler-read-failure probes publish collision first,
  make the handler's authoritative read fail, and preserve protocol status 67
  before the same TERM. Both prove mandatory child settlement and zero residue;
- verifier and harness decode-commit probes make the first ordinary outcome
  read fail to 67 while TERM is delivered before commit and a forbidden second
  read could observe collision 73. Both preserve 67 without re-entering the
  decoder and leave the signal helper plus every lifecycle artifact absent;
- the held-child watchdog uses a distinct failure marker and never creates the
  settlement-release marker. Every held probe asserts it did not fire, so a
  missing production release fails quickly instead of making the probe green;
- verifier and harness first-claim-read TERM probes both preserve 143, reconcile
  and remove the exact owned claim, and prove that no creation child or
  transaction file exists; and
- verifier/harness collision helpers forced to observe child status 42 plus
  marker-created assertion-window TERM and HUP→INT paths.

Every case leaves no exact registered worktree, claim, token, marker, or owned
temporary root. A clean incremental A6 `git diff --check` must exit 0 because
A6 introduces no new whitespace exception.
