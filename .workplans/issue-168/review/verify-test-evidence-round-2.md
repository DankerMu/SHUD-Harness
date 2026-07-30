# Round 2 verifier — test evidence

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`

Candidate: `ev-06`
Verdict: CONFIRMED
Disposition: FIX_NOW

The preload publishes separate wrappers through `globalThis`; controls
voluntarily retrieve them. Normal `node:fs` and `bun:ffi` imports are untouched.
Under the preload, normal `openSync("/etc/hosts")` succeeded with no event, while
production imports authority normally. The red patch only disables the wrapper
denial, so the claimed independent tripwire is not established.

Candidate: `ev-07`
Verdict: CONFIRMED
Disposition: FIX_NOW

The evidence manifest names the Phase 6.2 invariant audit, but `git cat-file`
and `git ls-files` cannot resolve it at the reviewed HEAD and `.gitignore`
matches the worktree copy. A clean clone cannot follow the declared evidence
chain. Track the audit or a complete equivalent artifact.
