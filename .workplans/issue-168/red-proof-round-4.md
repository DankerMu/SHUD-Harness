# Round 4 depth-retro compiling red proof

The source-only mutation in `red-proof-round-4.patch` adds eight compiling,
production-reachable post-admission routes. It covers computed specifiers through
`process.getBuiltinModule`, `import.meta.require`, and `createRequire`; the
previously unenumerated `statSync` and `createReadStream` APIs; sync and promise
read, write, and open; and absolute string, relative string, Buffer, and file-URL
PathLike forms. It also loads a harmless `getpid` symbol through computed
`bun:ffi` and attempts computed cached `child_process.execFileSync`.

Darwin Bun 1.2.19 returned exit 1, 19 pass, 2 fail, and 499 assertions. Linux
`oven/bun:1.2.19` with a read-only repository/root and writable `/tmp` tmpfs
returned exit 1, 19 pass, 2 fail, and 451 assertions. The two named failures were
`central capability boundary is the only OS authority import and direct commands
preserve input bytes` and `independent preload denies actual Node, Bun, and FFI
authority before side effects`.

The structural gate reported dynamic imports, computed-loader identifiers, and
non-allowlisted `process` properties. Independently, all eight runtime branches
were denied by the cached-builtin guard with exact normalized events:
`readFileSync`, `statSync`, `createReadStream`, `openSync`, `writeFileSync`, and
promises `readFile`, plus `ffi_dlopen` before the system library opened and
`node_child_process_execFileSync` before process creation. Replacement bytes
remained byte-identical and the write/spawn sentinel remained absent on both
platforms, proving zero read/write/process side effects.

The mutation was removed immediately after the two red runs. The patch applies
cleanly with `git apply --unidiff-zero --check`; no stash was used.
