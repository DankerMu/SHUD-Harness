# PR #170 Phase 6.2 invariant audit

Audited head: `052cb0719b9e10f0cbc18084bda1e41ec74e29cb`
Result: findings

## Clean inventory

Resource settlement is clean across admission, verification temporaries, retained
descriptors, both direct kinds, primary-plus-cleanup and cleanup-only faults.
Producer/result binding, canonical bytes, receipts, and excluded sibling scope
are also clean.

## P1 contract — malformed-token accounting is still non-transactional

Reproduced 512 array elements followed by `truX`, 512 object members followed by
a key without colon, and 2,047 scalars followed by an unterminated string under
relaxed items. They return item/node limits rather than malformed because counters
commit before the value/member is syntactically complete. Required closure:
syntax-invalid input wins over pending item/node limits, while valid exact/+1 and
duplicate-key behavior remain frozen; test all shapes through both public kinds.

## P1 test-evidence — authority fault controls do not attempt OS operations

The test enum calls `rejectForbidden` directly; the red patch imports and references
`openSync` but never calls it. `Bun.file`/`Bun.write`/`Bun.spawn` can bypass the
import audit. Required closure: an independent cross-platform runtime boundary
intercepts actual attempted ambient open/replacement read/write/spawn operations,
with compiling controls that execute each operation and turn red if interception
is removed. Static inventory remains supplementary evidence only.

Inventory covered shared helper roots, both public entrypoints, every contracts
filesystem/process import and call site, read/write/process surfaces, fixtures,
CI/evidence, and unchanged #169/#166/#162/runtime consumers. Network security was
excluded.
