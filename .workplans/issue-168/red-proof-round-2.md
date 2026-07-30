# Issue #168 Round 2 compiling behavioral red proof

Command on both Darwin and read-only Linux Bun 1.2.19:

`bun test spikes/git-status-capability/contracts/tests/source-ingress.test.ts`

Mutation source: `.workplans/issue-168/red-proof-round-2.patch`. It is a
compiling production-source mutation. It restores immediate nonfinite-number
rejection and injects a normal named `node:fs.writeFileSync` import plus a
post-admission write in `ContractCapabilities.readRetained` when the isolated
red-proof sentinel environment variable is present.

Darwin observed exit `1`: `18 pass`, `3 fail`, `501 expect() calls`.
Linux observed exit `1`: `18 pass`, `3 fail`, `453 expect() calls`.

Named failures on both platforms:

- `central capability boundary is the only OS authority import and direct commands preserve input bytes`
- `independent preload denies actual Node, Bun, and FFI authority before side effects`
- `pending item or node limits override later nonfinite number semantics`

The independent preload failure recorded `node_write:<sentinel>` through the
production module's normal import, returned contract exit 2, and proved
`sentinelExists: false` on both platforms. Thus the module interposer, rather
than a voluntary control wrapper or static audit, stopped the attempted write
before its side effect. The parser aggregate ran both public kinds, standalone
and trailing-syntax controls, and the relaxed-node control before asserting.

The fixed sources were restored immediately. SHA-256 matched all pre-mutation
files, no stash was used, and the patch passes `git apply --unidiff-zero --check`.
