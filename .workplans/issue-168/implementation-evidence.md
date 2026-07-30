# Issue #168 implementation evidence

Base: `f8b74e724dc978acb889f715a936feabfd69680d`
Branch: `codex/issue-168-source-ingress-capability`
Fixture: `expanded`; repair intensity: `high`
Date: 2026-07-30 EDT

## Scope

Implemented only the two direct input kinds, descriptor-capability ingress, the
normalized source-record contract, and their public tests. The committed current
oracle (#169), live Git authority (#166), aggregate evidence/publication (#162),
production/runtime/workflows, and network security remain absent.

## Red proof

The initial missing-module proof is superseded by the Round 1 compiling semantic
mutation proof. `.workplans/issue-168/red-proof-round-1.patch` mutates source only:
descriptor verification and central authority auditing, cleanup precedence,
post-comma accounting, exact depth and item capacity, result shape, canonical key
ordering, and four-SHA equality. The complete focused command executed and
returned exit `1`, `13 pass`, `10 fail`, with one named failure for every required
group; exact output is recorded in `.workplans/issue-168/red-proof-round-1.md`.
The fixed source was restored immediately with `apply_patch`, matched the saved
pre-mutation bytes, and returned `23 pass`, `0 fail`. No stash was used or remains.

## Round 1 fix verification

- `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests`:
  Darwin 23 pass, 0 fail, 530 assertions.
- Both direct `check.ts --input ... --kind ...` commands: exit 0, one exact
  LF-terminated success receipt, empty stderr.
- Close-fault settlement: admission, retained cleanup, and verification-temporary
  descriptor faults run for both kinds; primary `CONTRACT_BYTES_LIMIT` survives,
  cleanup-only is `CONTRACT_SCHEMA_INVALID`, and exact close attempt counts prove
  every remaining retained descriptor is settled.
- Parser ordering: 512 zeroes plus trailing comma is malformed for both public
  kinds; 2,047 plus comma under relaxed items is malformed before node accounting.
- Exact public depth: depth 12 reaches `CONTRACT_SCHEMA_INVALID`; depth 13 returns
  `CONTRACT_JSON_DEPTH_LIMIT` for both kinds.
- Canonical admission bytes match the committed multi-key Unicode oracle
  `source-input-record-paired-surrogate.canonical.json`.
- The voluntary descriptor observer remains diagnostic only. OS authority is
  mechanically centralized in `lib/capabilities.ts`; the whole implementation
  audit rejects other FS/process imports, and active gate controls reject ambient
  absolute open, replacement-object read, write, and child-spawn requests before
  an OS operation. The compiling mutation proves the audit and path tests turn red.
- Capacity: 237 short entries = 8,339 bytes and 512 items, success; 238 = 8,364
  bytes and 514 items, `CONTRACT_JSON_ITEM_LIMIT`.
- Node option 1: 2,048 nodes parses under an independently relaxed item ceiling;
  2,049 returns `CONTRACT_JSON_NODE_LIMIT`.
- `npx --yes bun@1.2.19 run typecheck`: pass.
- `npx --yes bun@1.2.19 run check`: pass.
- `npx --yes @fission-ai/openspec@1.3.1 validate
  m2-capability-observer-spike --strict --no-interactive`: valid.
- `git diff --check`, empty stash, submodule diff, and scope scans: clean.

Darwin executed the full descriptor-stress matrix locally. The exact current tree
also ran read-only in `oven/bun:1.2.19` on Linux: `Linux`, Bun `1.2.19`, 23 pass,
0 fail, 482 assertions. The image does not contain `npx`, so the literal CI command
returned `npx: not found` before tests; the equivalent in-image pinned command was
`bun test spikes/git-status-capability/contracts/tests`. Required GitHub Linux and
macOS jobs now contain the literal pinned `npx --yes bun@1.2.19 test ...` step.

## Phase 6.2 invariant closure

- Parser item/node ceiling failures are now pending until the complete root JSON
  value and trailing-input check succeed. Syntax and duplicate-key failures remain
  immediate; depth remains immediate; the first valid item/node crossing is
  committed after syntax validation.
- Both public kinds prove malformed precedence for 512 array elements followed by
  `truX`, 512 object members followed by a key without a colon, and the existing
  post-comma case. A relaxed item ceiling independently proves 2,047 scalars plus
  an unterminated string is malformed instead of a node-limit result. Existing
  depth, 237/238-entry, 2,048/2,049-node, duplicate, byte, and valid-limit tests
  remain green.
- A spawned public/test process now loads an independent preload boundary. After
  descriptor admission it attempts actual Node absolute open/read/write/spawn,
  Bun `file`/`write`/`spawn`, and FFI libc `open` routes. The boundary records the
  concrete attempted path/operation and throws before the original operation;
  exact contract failure output plus absent sentinels and byte-identical input and
  replacement files are asserted for both public kinds. Uncontrolled commands
  under the same preload retain exact success receipts. The static import audit
  and enum fault gate remain supplementary checks.
- `.workplans/issue-168/red-proof-phase-6-2.patch` is a compiling source-only
  mutation: immediate parser limit failure plus record-only authority guards. The
  full focused file returned exit `1`, `18 pass`, `2 fail`, `505 assertions`; all
  eight controls executed, actual writes/spawns created sentinels, and the named
  parser and authority tests failed. Restored green returned `20 pass`, `0 fail`,
  `507 assertions`; SHA-256 matched the pre-mutation files; no stash remains.
- Final Darwin focused suite: `24 pass`, `0 fail`, `531 assertions`. Both exact
  direct commands exit 0 with their sole LF-terminated success receipt and empty
  stderr. `typecheck`, full `check`, strict OpenSpec validation, and
  `git diff --check` pass.
- Final Linux verification used `oven/bun:1.2.19`, a read-only repository mount,
  a read-only container root, and an isolated writable `/tmp` tmpfs: `24 pass`,
  `0 fail`, `483 assertions`. An initial attempt without the `/tmp` tmpfs produced
  only `EROFS` fixture-setup failures; it was corrected at the container boundary
  and is not counted as code verification.
- CI remains unchanged in this phase and contains exactly the prior two pinned
  focused commands, one in each required Linux/macOS job.

## Deviations

Sole accepted deviation: `.github/workflows/ci.yml` adds only the pinned focused
contract command to the existing required `linux-base` and `macos-seatbelt` jobs.
Phase 6.2 has no additional deviations.
