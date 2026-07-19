# Round 2 depth repair green and verification evidence

- Date: 2026-07-19
- Working branch: `codex/issue-108-ledger-foundation`
- Frozen red source: `b425a68aa6e3f886c424d439f48bb97ac05bac23`
- The exact semantic repair commit is bound by the final Round 2 section in
  `../verification.md` after the implementation commit is created.

## Identical core red/green command

```sh
npx --yes bun@1.2.19 test openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/round2-depth-regression.test.ts
```

Result: exit 0; 5 pass, 0 fail, 46 assertions.

## Final affected suites

- Dedicated core/backend ledger boundary: exit 0; 27 pass, 0 fail,
  376 assertions across 2 files.
- Core services: exit 0; 430 pass, 5 platform-conditioned skips, 0 fail,
  29,117 assertions across 2 files.
- Backend API: exit 0; 161 pass, 0 fail, 5,092 assertions across 2 files.
- Typecheck: exit 0.
- Root `npx --yes bun@1.2.19 run check`: exit 0; all policy,
  tool-registry, backend HTTP/WebSocket, frontend, schema, core-service, and
  GLM-provider suites completed.
- Strict OpenSpec validation: exit 0; change is valid.
- `git diff --check`: exit 0; `git stash list` contains no `red-proof` stash.
- Final full-inventory Phase 6.2 audit: clean across shared helper, public
  entrypoint, producer/consumer, rollback/release, stale/idempotency, and
  unchanged-consumer surfaces.

## Declaration and scope evidence

Using `rg -c '^\s*test\('`, the dedicated core and backend files contain 24
and 3 declarations (27 total, matching runtime). The large core service file
contains 396 declarations versus 381 at base; backend routes contain 158 versus
154 at base. No dependency manifest, `zero/` gitlink, workspace output, or
persisted/public HTTP schema is changed by this repair.

The semantic change uses occurrence/adoption-only transport, discriminated
outcomes for exact undefined rejection, a closure-branded authority carrier,
transactional phase grammar, and an order-independent bounded max-heap for the
lowest canonical numeric keys. The final Phase 6.2 audit found no remaining
matching unsafe surface.
