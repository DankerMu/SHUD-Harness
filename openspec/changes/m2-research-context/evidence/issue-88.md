# Issue #88 — frontend local-auth delivery evidence

- Workflow: `subagent-workflow`
- Fixture: expanded
- Risk: high
- Scope: `packages/frontend` API/bootstrap + Dashboard migration; `packages/backend` production entry page
- Parent task: `tasks.md` 1.2

## Invariant matrix

| Invariant | Boundary | Evidence |
|---|---|---|
| The browser credential exists only in the inline bootstrap object and `Authorization` header. | HTML serialization, browser memory, request construction | Bootstrap serializer escapes script-context delimiters; frontend tests deny URL/query/localStorage use; production entry uses `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. |
| Every browser `/api/**` call uses one API-layer wrapper. | Dashboard create/list and future frontend API consumers | Dashboard resolves `window.__HARNESS_API_FETCH__`; API tests prove caller headers cannot remove/replace the canonical Bearer header. |
| Credentials cannot cross an origin or leave the API namespace. | URL, `URL`, and `Request` inputs | Wrapper rejects cross-origin, protocol-relative, and non-`/api/**` targets before invoking native fetch. |
| Entry HTML cannot disclose a token through an attacker-controlled Host. | Production `/` and `/dashboard` handlers | Only `127.0.0.1` and `localhost` hostnames receive the page; other Host values receive a generic 404 without bootstrap bytes. |
| A stale/replaced token authority is never published. | Initial HTML render | The production handler validates the authority before and after server-side snapshot rendering and returns a generic 503 on any mismatch. |
| Existing M1 create/list semantics remain unchanged. | Dashboard POST followed by GET | The browser-style backend test executes bootstrap, wrapper, and Dashboard scripts against the real auth middleware and asserts both requests succeed with the same Bearer token. |

## Risk packs

### RP-1: inline script breakout

A valid local token may contain quotes, backslashes, angle brackets, or a literal `</script>` sequence. The bootstrap serializer encodes `&`, `<`, `>`, U+2028, and U+2029 after JSON serialization. Unit coverage executes the generated script with an adversarial token and verifies exactly one script element is produced and the original bytes round-trip in memory.

### RP-2: header override and credential exfiltration

The wrapper merges `Request` headers and `init.headers`, then sets `Authorization` last. Calls targeting a different origin, a protocol-relative URL, or a path outside `/api/**` fail before the native fetch seam is called.

### RP-3: page caching and origin confusion

Credential-bearing entry responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and no CORS response header. The production handler additionally rejects non-loopback Host hostnames.

### RP-4: backend/frontend authority drift

The production page resolves the same workspace root and local-token authority contract as the API layer. It validates the page authority before and after the authenticated server-side task snapshot. Any failure is rendered as a generic 503 without the token or workspace path.

## Boundary-surface checklist

- [x] `window.__HARNESS_BOOTSTRAP__` is frozen, non-enumerable, non-writable, and non-configurable.
- [x] `window.__HARNESS_API_FETCH__` is the sole browser API request seam and is read-only.
- [x] Dashboard POST and refresh GET no longer call native fetch directly.
- [x] `Authorization` is forced after caller header merge.
- [x] Cross-origin and non-API targets are rejected before transport.
- [x] No token is written to URL/query, localStorage, cookie, or logs.
- [x] Production entry HTML is no-store and emits no CORS header.
- [x] Loopback Host and token-authority freshness are checked fail-closed.
- [x] M1 response-schema validation and no-phantom-row behavior remain covered by the existing frontend suite.

## Verification evidence

Locally executed for the macOS fixture repair:

- Before the repair, `npx --yes bun@1.2.19 test packages/backend/src/routes/frontend-entry.test.ts` reproduced the fail-closed path: 1 passed and 1 failed because workspace initialization returned 500 instead of 200.
- After canonicalizing both temporary fixture roots, the same focused command passed: 2 passed, 0 failed.
- `npx --yes bun@1.2.19 run test:backend-api` passed: the route suite reported 181 passed, 1 skipped, 0 failed; the local-auth adversarial matrix reported 92 passed, 2 skipped, 0 failed.
- `npx --yes openspec validate m2-research-context --strict --no-interactive` passed.
- `git diff --check` passed.

This repair changes test fixtures and verification evidence only. Production workspace path-safety remains unchanged.

Required repository gates on the PR head:

- `bun run test:frontend`
- `bun run test:backend-api`
- `bun run check`
- `bun run test:perf:api`
- `npx --yes openspec validate m2-research-context --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
- `test -z "$(git ls-files workspace)"`
