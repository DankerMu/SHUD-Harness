# Issue #168 Phase 6.2 invariant-closure red proof

Command:

`npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests/source-ingress.test.ts`

Mutation source: `.workplans/issue-168/red-proof-phase-6-2.patch`. The patch is
source-only and compiling. It restores immediate parser limit failure and removes
the independent preload guard's throw while retaining the calls to the original
Node, Bun, and FFI operations.

Observed result: exit `1`; `18 pass`, `2 fail`, `505 expect() calls`.

Named failures:

- `independent preload denies actual Node, Bun, and FFI authority before side effects`
- `malformed array values and object members override pending item or node limits`

The authority failure ran all eight controls before asserting. Its diff recorded
successful ambient Node and FFI opens, successful Node and Bun replacement reads,
created sentinels for Node/Bun writes and child spawns, contract success receipts,
and the missing denial events. The parser aggregate ran every public-kind/shape
pair before asserting: malformed token, member, and long-array controls returned
`CONTRACT_JSON_ITEM_LIMIT`, while the relaxed-item parser control returned
`CONTRACT_JSON_NODE_LIMIT`, instead of the required malformed result.

The fixed source was restored immediately. SHA-256 comparison against both
pre-mutation files matched, the focused suite then returned `20 pass`, `0 fail`,
`507 expect() calls`, and no stash was created.
