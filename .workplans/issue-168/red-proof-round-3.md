# Issue #168 Round 3 closed-authority red proof

Command on both Darwin and a read-only Linux Bun 1.2.19 container:

`bun test spikes/git-status-capability/contracts/tests/source-ingress.test.ts`

Mutation source: `.workplans/issue-168/red-proof-round-3.patch`. It is one
compiling production-source matrix inserted after descriptor admission. Separate
child processes select all of these normal production authority routes:

- canonical `node:fs.openSync` with a file URL;
- bare `fs.openSync` with a Buffer;
- canonical `node:fs/promises.readFile` with an absolute string;
- bare `fs/promises.readFile` with a file URL;
- canonical `node:fs/promises.writeFile` with a file URL sentinel;
- `Bun.file` with a file URL.
- same-module `node:fs.statSync` with a file URL in the closed capability module.

Darwin observed exit `1`: `19 pass`, `2 fail`, `504 expect() calls`.
Linux observed exit `1`: `19 pass`, `2 fail`, `456 expect() calls`.

Named failures on both platforms:

- `central capability boundary is the only OS authority import and direct commands preserve input bytes`
- `independent preload denies actual Node, Bun, and FFI authority before side effects`

The production aggregate executed every matrix branch before asserting. Exact
events were `node_open`, `node_promises_read`, `node_promises_write`, and
`bun_file` with normalized absolute targets. Those six children returned contract
exit 2; the replacement bytes remained identical and the write sentinel remained
absent on both platforms. The same-module `statSync(URL)` branch executed
successfully at runtime, while the independent exact import-declaration audit
caught its added named API. The static closed-vocabulary audit also reported
every added module alias.

The production source was restored immediately. SHA-256 matched the
pre-mutation file, no stash was used, and the patch passes
`git apply --unidiff-zero --check`.
