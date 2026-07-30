# Issue #168 implementation evidence

Base: `f8b74e724dc978acb889f715a936feabfd69680d`
Branch: `codex/issue-168-source-ingress-capability`
Fixture: `expanded`; repair intensity: `high`
Date: 2026-07-29 EDT

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

## Deviations

Sole accepted deviation: `.github/workflows/ci.yml` adds only the pinned focused
contract command to the existing required `linux-base` and `macos-seatbelt` jobs.
