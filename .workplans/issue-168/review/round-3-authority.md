# PR #170 Round 3 authority/resource review

Reviewed head: `17f89edd0eecfdd71834e6ee77ba5d5716d1f7d1`
Verdict: not clean; one P1 candidate.

## P1 test-evidence — standard PathLike and promise APIs bypass the tripwire

The preload recognizes only absolute strings and mocks only `node:fs`, not
`node:fs/promises`. Normal `openSync(URL)`, `openSync(Buffer)`, promise
`readFile(string)`, and `Bun.file(file URL)` therefore bypassed on both Darwin
and read-only Linux Bun 1.2.19 with empty event lists. The static audit also
permits these routes.

The post-admission authority proof must cover the complete supported PathLike
forms and reachable filesystem API/module aliases, or enforce a closed
production authority vocabulary. Add compiling production-import controls for
URL, Buffer, promise FS and Bun file URLs, with pre-side-effect rejection and
unchanged replacement/sentinel bytes on both platforms. Blocking: yes.

String route module interposition, Bun write/spawn, FFI open, descriptor cleanup
and the existing production mutation were otherwise clean.
