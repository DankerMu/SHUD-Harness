# Round 3 verifier — test evidence

Reviewed head: `17f89edd0eecfdd71834e6ee77ba5d5716d1f7d1`

Candidate: `ev-08`
Verdict: CONFIRMED
Disposition: FIX_NOW

The preload rejects only absolute strings, mocks `node:fs` but not
`node:fs/promises`, and applies the same string-only predicate to `Bun.file`.
On both Darwin and Linux Bun 1.2.19, normal `openSync(URL)`,
`openSync(Buffer)`, promise `readFile("/etc/hosts")`, and `Bun.file(file URL)`
succeeded with no guard events while the focused suite stayed green. These are
supported filesystem forms reachable from the permitted production authority
module, so the active zero-ambient-reopen evidence is incomplete. FIX_NOW.
