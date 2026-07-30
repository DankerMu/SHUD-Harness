# PR #170 Round 1 verified-finding synthesis

Reviewed head: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Verified: 7 CONFIRMED / FIX_NOW; highest P1.

## Resource closure

- Preserve an already-selected `ContractError` when cleanup also fails; surface
  cleanup-only failure as schema-invalid and attempt every remaining close.
- Add deterministic close-fault injection for admission and post-admission paths,
  both direct kinds, exact receipts, and close-attempt counts.

## Parser contract closure

- Detect an invalid post-comma array token before item/node accounting.
- Cover 512 elements plus comma through both public kinds and 2,047 plus comma
  under relaxed item limits; all must return malformed, while 237/238 capacity
  remains unchanged.

## Evidence closure

- Add the pinned focused suite to both existing Linux and macOS required CI jobs;
  no new spike workflow behavior or production path.
- Strengthen the path/write/process proof so it does not rely only on voluntary
  operation callbacks: centralize the permitted filesystem capability surface,
  audit the complete implementation surface, and include active compiling fault
  controls that introduce an unreported ambient open/replacement read/write/spawn
  and prove the guard turns red.
- Add public exact depth-12/+1 receipts and a fixed multi-key Unicode canonical
  byte oracle.
- Replace the missing-module red narrative with one batched, compiling,
  source-only semantic mutation covering descriptor verification, parser bounds,
  normalized tuple/result shape, canonical bytes, and four-SHA equality; persist
  the patch and named red output, restore immediately, leave no stash.

Scope remains direct input contracts/tests/evidence. #169 current oracle, #166,
#162, production/runtime, and network security remain absent. The two existing CI
job command additions are recorded as the sole plan deviation because exact-head
Darwin/Linux evidence cannot otherwise become a required PR gate.
