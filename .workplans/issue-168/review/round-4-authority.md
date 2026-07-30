# PR #170 Round 4 authority-depth review

Reviewed head: `cc89c89da7af3d68e0004766b495e5e72988036e`
Verdict: not clean; one P1 candidate, deduplicated with the full-scope review.

## P1 test-evidence — alternate builtin loaders bypass both proof layers

`process.getBuiltinModule("node:" + "fs")`,
`import.meta.require("node:" + "fs")`, and computed `createRequire` return the
real builtin rather than the mocked module. Current source patterns also miss
the computed specifier. On Darwin, builtin/meta reads succeeded with empty
events and a write created a temporary sentinel; on read-only Linux both reads
succeeded with empty events. The reviewer removed its temporary sentinel.

Close computed loader/dynamic-code authority structurally or interpose the
actual builtin object/OS boundary, and use production mutations for read/write/
open through all three loaders plus an unenumerated FS API. Blocking: yes.

Descriptor/resource settlement was clean; network security and excluded sibling
issues were not reviewed.
