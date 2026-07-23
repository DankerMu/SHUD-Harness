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
| Credentials cannot cross an origin or leave the API namespace. | String, `URL`, and `Request` inputs; native redirects | Both wrapper copies reject raw `//` strings before URL normalization, reject cross-origin and non-`/api/**` targets, and force `redirect: "error"` after caller-init merge. |
| Entry HTML cannot disclose a token through an attacker-controlled Host or framing context. | Production `/` and `/dashboard` handlers | Only `127.0.0.1` and `localhost` hostnames receive the page; the common page headers deny framing, and other Host values receive a generic 404 without bootstrap bytes. |
| A stale/replaced token authority is never published. | Initial and post-render HTML proofs | Deterministic file-backed tests replace the authority before the first proof and during task snapshot rendering; both aliases return a generic, non-leaking 503. |
| Existing M1 create/list semantics remain unchanged. | Dashboard POST followed by GET | The browser-style backend test executes bootstrap, wrapper, and Dashboard scripts against the real auth middleware and asserts both requests succeed with the same Bearer token. |

## Risk packs

### RP-1: inline script breakout

A valid local token may contain quotes, backslashes, angle brackets, or a literal `</script>` sequence. The bootstrap serializer encodes `&`, `<`, `>`, U+2028, and U+2029 after JSON serialization. Unit coverage executes the generated script with an adversarial token and verifies exactly one script element is produced and the original bytes round-trip in memory.

### RP-2: header override and credential exfiltration

The wrapper merges `Request` headers and `init.headers`, then sets `Authorization` last. Calls targeting a different origin, a raw protocol-relative URL, or a path outside `/api/**` fail before the native fetch seam is called. Both the typed wrapper and evaluated inline-script copy force `redirect: "error"` after caller-init merge. A real loopback server test returns `/api/start -> /dashboard` and proves default redirect behavior and caller-supplied `redirect: "follow"` both stop after the one authenticated API request.

### RP-3: page caching and origin confusion

Credential-bearing entry responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, and no CORS response header. The production handler additionally rejects non-loopback Host hostnames.

### RP-4: backend/frontend authority drift

The production page resolves the same workspace root and local-token authority contract as the API layer. It validates the page authority before and after the authenticated server-side task snapshot. Any failure is rendered as a generic 503 without the token or workspace path.

## Boundary-surface checklist

- [x] `window.__HARNESS_BOOTSTRAP__` is frozen, non-enumerable, non-writable, and non-configurable.
- [x] `window.__HARNESS_API_FETCH__` is the sole browser API request seam and is read-only.
- [x] Dashboard POST and refresh GET no longer call native fetch directly.
- [x] `Authorization` is forced after caller header merge.
- [x] Raw `//` strings, cross-origin targets, and non-API targets are rejected before transport in both wrapper copies.
- [x] Caller redirect settings cannot override fail-closed native redirect behavior.
- [x] No token is written to URL/query, localStorage, cookie, or logs.
- [x] Production entry HTML is no-store, denies framing, and emits no CORS header.
- [x] Loopback Host and token-authority freshness are checked fail-closed.
- [x] M1 response-schema validation and no-phantom-row behavior remain covered by the existing frontend suite.
- [x] `bun.lock` records the backend-to-frontend workspace edge and its SHA evidence matches.

## Verification evidence

Automated commands executed locally with the pinned toolchain for the Round 1 invariant closure:

- Focused green: `npx --yes bun@1.2.19 test packages/frontend/src/api/index.test.ts packages/backend/src/routes/frontend-entry.test.ts` passed with 13 tests, 0 failures, and 116 assertions.
- Batched source-only red proof: stashing only `packages/frontend/src/api/index.ts` and `packages/backend/src/production-server.ts` produced 3 passes and 9 failures against the pre-fix sources. Failures exercised caller redirect override, typed and inline raw `//127.0.0.1:3000/api/tasks`, real loopback redirect following, and missing anti-frame headers. The two stale-authority status/body/non-disclosure paths are coverage-only for the pre-existing pre/post `assertCurrent()` guard; their shared new anti-frame assertion was the only part expected to fail against pre-fix source. The stash was popped immediately and no `red-proof` stash remains.
- Wrapper proof: the focused suite evaluates both wrapper implementations. Raw same-origin network-path strings reject before transport; the real loopback `/api/start -> /dashboard` fixture observes exactly one request carrying the canonical Bearer header for each wrapper under both default caller init and caller `redirect: "follow"`.
- Page proof: the focused backend entry suite covers successful `/` and `/dashboard` responses with CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, the existing no-store/no-referrer/nosniff headers, and no CORS. Hostile Host remains a generic non-leaking 404.
- Authority proof: with `HARNESS_LOCAL_TOKEN` absent, file authority replacement before the `/dashboard` proof and during `/` task-snapshot rendering both return exact `Service Unavailable` 503 responses without bootstrap marker, old/new token, workspace path, or CORS.
- `npx --yes bun@1.2.19 run test:frontend` passed: 28 passed, 0 failed, 180 assertions. This includes the unchanged Dashboard malformed payload, invalid status, error-state, refresh, and no-phantom-row cases.
- `npx --yes bun@1.2.19 run test:backend-api` passed. Its route suite reported 184 passed, 1 skipped, 0 failed, 5,496 assertions; the local-auth adversarial matrix reported 92 passed, 2 skipped, 0 failed, 388 assertions.
- `npx --yes bun@1.2.19 run typecheck` passed.
- Bun 1.2.19 regenerated the backend importer with `@shud-harness/frontend: workspace:*`. `npx --yes bun@1.2.19 install --frozen-lockfile` then checked 188 installs across 187 packages with no changes. The resulting `bun.lock` SHA-256 is `1653b2c991de952c1036415aee37ca96e3f279c493b589b156ddc3f24c74448d`; `dependency-lock.initial.json` changes only that SHA field and retains the package inventory.
- `npx --yes bun@1.2.19 run validate:dependency-lock` passed with 20 direct external workspace dependencies and all four submodules matching.
- `npx --yes bun@1.2.19 run test:dependency-lock` passed its positive and negative fixtures.
- `npx --yes openspec validate m2-research-context --strict --no-interactive` passed.
- `git diff --check`, the changed-file DEBUG scan, and red-proof stash hygiene passed.

The orchestrator completed the Phase 6 real-browser walkthrough with `agent-browser` against the production Bun listener on `127.0.0.1`. After authenticated workspace initialization, the Dashboard loaded through `/dashboard`, submitted a `science_assist` TaskCard with `deep` inference budget, and rendered the newly created `TASK-*` row after the follow-up list refresh. The listener log recorded the expected initial `GET /api/tasks`, `POST /api/tasks` `201`, and refresh `GET /api/tasks` `200` entries without credential values. The browser remained on the token-free `/dashboard` URL; `localStorage`, `sessionStorage`, and `document.cookie` were empty; and both readonly bootstrap/wrapper globals were installed. A direct response-header check confirmed `Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'none'`, and `X-Frame-Options: DENY`. The browser session and temporary listener were closed after verification.

There is no product or contract deviation; production token-store and path-safety behavior remain unchanged.

Required repository gates on the PR head:

- `bun run test:frontend`
- `bun run test:backend-api`
- `bun run check`
- `bun run test:perf:api`
- `npx --yes openspec validate m2-research-context --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
- `test -z "$(git ls-files workspace)"`
