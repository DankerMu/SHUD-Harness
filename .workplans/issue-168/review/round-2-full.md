# PR #170 Round 2 full-scope review

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`
Verdict: not clean; one P1 candidate.

## P1 test-evidence — preload does not intercept production imports

The post-admission authority proof must independently intercept real ambient
filesystem/process authority rather than rely on the tested code selecting a
test wrapper. `authority-preload.ts` builds `guardedFs` and `guardedDlopen` and
publishes them through `globalThis`, while `authority-control.ts` voluntarily
retrieves those wrappers. Production `capabilities.ts` still uses ordinary
named imports from `node:fs` and `bun:ffi`. Under the same preload, a normal
`node:fs.openSync("/dev/null", O_RDONLY)` succeeded with no guard event.

A future post-admission ambient open through the production import path could
therefore leave the focused suite green. The Phase 6.2 red patch also disables
only the wrapper's `deny` function and does not inject a violation into the
production capability path. Use real module/syscall interposition and a
compiling production-path mutation on Darwin and Linux. Blocking: yes.

The full PR diff, Issue/OpenSpec contract, prior seven verified findings,
resource/error paths, normalized record, public receipts, and excluded sibling
scope were inspected. No second candidate was found. Network security and the
#162/#166/#169-exclusive implementations were excluded.
