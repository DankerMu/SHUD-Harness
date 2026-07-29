# PR #167 evidence manifest

Current repaired head SHA: 3c011939ac5c793f7ab1028931b5b216b7b2008c
Base SHA: f8b74e724dc978acb889f715a936feabfd69680d
Issue: #164
Fixture: expanded, repair intensity high
Review round: 3 (not clean; retro registered)
Deviation record: Round 3 depth-shaped invariant-closure retry recorded in `review-failure-retro-round-3.md`

Local verification:

- Round 3 invariant-closure replay: pre-repair source blobs 41 pass / 6 expected fail / exit 1; restored fixed source 47 pass / 0 fail / 738 assertions. See `red-proof-round-3-invariant-closure.md`.
- Current invariant-closure contracts: 50 pass, 0 fail, 762 assertions.
- Phase 6.2 semantic-identity replay at `4d7fa16`: 0 pass / 3 expected fail / exit 1; restored fixed source 3 pass / 0 fail. Full focused suite after this repair: 53 pass, 0 fail, 768 assertions. See `red-proof-phase-6-2-semantic-identity.md`.
- Initial committed contracts: 24 pass, 0 fail, 279 assertions.
- Phase 6 committed contracts: 27 pass, 0 fail, 366 assertions.
- Three frozen public commands: exact success receipts.
- Strict OpenSpec validation: valid.
- Full repository check: exit 0.
- Current-source status/no-write proof: unchanged.
- Scope, package, workflow, submodule, stash, debug-marker, and diff hygiene: clean.

Round 1 Phase 6 status:

- `DI-01`: implemented and focused-regression verified.
- `TE-02`: implemented and focused-regression verified.
- `TE-01`: byte/depth/item public evidence implemented; isolated parser node exact/+1 evidence implemented.
- `CT-02`: closed by user-approved option 1. The OpenSpec now records the frozen `nodes = items + 1` relationship, classifies node as a dominated defense-in-depth guard, and preserves its isolated parser boundary evidence without changing counting or limits.
- `RS-01`: deferred to #162.
- Round 2: one verified P1 `compatibility` finding (`readIndex` rejected legal Git index v4) was fixed in `3a61a54` with normal and linked public-seam regression proof.
- The extension-closure audit found one verified ordering gap; `72d71e4` now enforces strict raw UTF-8 stage-0 ordering before candidate filtering and adds normal/linked v4 rejection plus v2/v3 acceptance evidence.
- The final parser audit verified two additional semantic gaps at `72d71e4`; `011a20c` closes entry flags/name-length/padding and optional-vs-mandatory extension handling with public red-green evidence.
- The `011a20c` closure audit found one common-config authority gap; `a04f5c3` adds bounded section-aware object-format parsing with real normal/linked SHA-1/SHA-256 and hostile-config evidence.
- The Phase 6.2 audit at `a04f5c3` initially reported clean, but Round 3 invalidated that conclusion with seven verified findings across compatibility, contract, data-integrity, and test-evidence; see `round-3-candidate-synthesis-a04f5c3.md` and `verify-round-3.md`.
- Round 3 at `a04f5c3`: not clean. A depth retro is registered and one comprehensive invariant-closure retry is in progress.
- Commit `4d7fa1664d2fcf718daaa800d8a5d13878a65912` contains the comprehensive retry and is pushed at the remote branch tip. Final Phase 6.2 and Round 4 verification are pending.
- Phase 6.2 at `4d7fa16` found one confirmed data-integrity sibling gap: semantic metadata/frame/sidecar reopened verified paths. The working repair reuses verified descriptor bytes and performs a final generation check; commit/push and Phase 6.2 re-audit remain pending.
- Commit `3c011939ac5c793f7ab1028931b5b216b7b2008c` contains that repair and is pushed at the remote tip; Phase 6.2 re-audit is in progress.
- Phase 6.2 final re-audit at `3c011939ac5c793f7ab1028931b5b216b7b2008c`: clean, no P0/P1/P2; see `phase-6-2-final-clean-3c01193.md`. Post-retro Round 4 is pending.
- Routed residual: `RS-01` aggregate current-source traversal/read budgets remain deferred to #162. This PR owns descriptor/path authority for the files it admits, not #162's collection-wide resource ceilings.

Reviewer lens mix: correctness, integration, resource/path/performance, test/evidence, spec compliance, invariant/state/compatibility.
