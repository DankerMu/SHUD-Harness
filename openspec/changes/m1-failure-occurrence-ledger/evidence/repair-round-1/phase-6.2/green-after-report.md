# Phase 6.2 invariant closure green evidence

- Date: 2026-07-19
- Frozen repair base: `a370f8e3a510b34c47d642f10f7d095aa8bb4b26`
- Working branch: `codex/issue-108-ledger-foundation`
- Repair state: uncommitted source/test/evidence diff on the frozen base; the
  parent orchestrator owns commit, push, review, and final SHA binding.
- Plan deviations: none. Existing assertions that counted a carrier reached
  only through an ordinary `cause` edge as current-operation occurrences were
  updated under the fixture's explicit supersession of implicit adoption; raw
  failures remain freshly observable through frozen carrier graph edges.

## Closed findings

1. Ordinary `cause`, `errors`, and `semanticPrimary` traversal no longer adopts
   an encountered carrier ledger. `PreservedFailureCarrier` exposes frozen own
   `semanticPrimary`/`errors` graph edges, so raw failures remain freshly
   observable without copying occurrence IDs, phases, or orders. Explicit
   primary/later carrier/ref adoption remains unchanged.
2. `runWithPreservedRelease` transports an optional semantic-primary occurrence
   captured at the physical catch site. The idempotency authority wrapper uses
   that exact occurrence, yielding `body, final_release` with strictly
   increasing unique orders instead of recreating the body after release.
3. Idempotency authority transport inspection uses own data descriptors and at
   most 16 prototype hops. Backend authority wrappers use a constructor-owned
   private `WeakSet` brand at all five consumers. Cyclic and fresh-per-hop Proxy
   inputs terminate at the real idempotency, backend finalizer, and serializer
   boundaries.
4. Simultaneous edge and numeric-key exhaustion records one occurrence for each
   exhausted budget independently.

## Phase 6.2 invariant surface inventory

- Shared helper roots: clean — explicit adoption remains only in the primary/
  later trusted occurrence paths; ordinary graph traversal does not call
  `adoptLedger`.
- Public entrypoints: clean — backend serialization and replay/finalizer
  consumers use the private brand and retain the existing typed/generic HTTP
  mapping.
- Read surfaces: clean — carrier raw graph values remain observable while
  `failureEvents` stays operation-local.
- Write/delete/overwrite surfaces: clean, unchanged — full core regression
  retained workspace/idempotency authority, cleanup, and retry behavior.
- Staging/publish/rollback surfaces: clean — real idempotency wrapper asserts
  exact physical `body, final_release`; full core release/rollback rows pass.
- Producer/consumer evidence boundaries: clean — catch-site occurrence flows
  through the shared helper and typed adapter; focused and full suites pass.
- Stale-state/idempotency boundaries: clean for issue #108 — hostile prototype
  consumers are bounded; private transition-ticket Child B remains outside this
  fixture as declared in `design.md`.
- Unchanged downstream consumers: clean — frontend, schema, WebSocket, policy,
  tool registry, GLM provider, Zero, and read-only submodules have no source
  diff; the root check passes.

## Verification

Focused final command:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts ./packages/backend/src/routes/index.test.ts -t 'Phase 6\.2|S34-P62-04 compound settlement and release failure'
```

Result: exit 0; 5 pass, 561 filtered out, 0 fail, 47 assertions across
3 files.

Additional final-base verification:

- `npx --yes bun@1.2.19 run test:core-services`: exit 0; 406 pass,
  5 platform-dependent skip, 0 fail, 28,650 assertions across 2 files.
- `npx --yes bun@1.2.19 run test:backend-api`: exit 0; 158 pass,
  0 fail, 5,041 assertions across 2 files.
- `npx --yes bun@1.2.19 run typecheck`: exit 0.
- `npx --yes bun@1.2.19 run check`: exit 0 on the final working-tree source;
  typecheck, policy gate, tool-registry governance, backend API/WebSocket,
  frontend, schemas, core services, and GLM provider all passed.
- `npx --yes openspec validate m1-failure-occurrence-ledger --strict --no-interactive`:
  exit 0, change valid.
- `git diff --check`: exit 0.
- Declaration retention: idempotency service test declarations 381 -> 382;
  backend route test declarations 154 -> 155; no base declaration removed.
- Stash hygiene: the final replay used one source-only
  `red-proof-phase62-final` stash, popped and dropped in the same command;
  `git stash list` has no `red-proof` entry.
- Submodule/workspace hygiene: no submodule gitlink diff; `zero/` is clean at
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; the other read-only submodules
  remain uninitialized and unchanged.

The replayable red proof remains in `red-before-tests.patch` and
`red-before-report.md`: exit 1 with all four new invariant rows red on frozen
product source, no source stash, and the pre-existing S34 HTTP mapping row
still green.

## Hash binding

Files:

- `packages/core/src/domain/services/compensation-error-preservation.ts`:
  `fabe513b2fe043a380f3ce1754ea6751ab0f1d6c77898a2253ab5c8266f539bc`
- `packages/core/src/domain/services/idempotency-service.ts`:
  `f1a98dc0f915fff04aac552129531a24f5b46e0d5e9c03056c59931806453cc5`
- `packages/backend/src/routes/index.ts`:
  `efcba7c234416170122b98ec24194df0e9b89f98f73c46c5fd7bea863827375e`
- `packages/core/src/domain/services/failure-occurrence-ledger.test.ts`:
  `d07f70e4d992095e9741ae984494b6bfbfdc8e1f48f61bd15816e85f8a7d0557`
- `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`:
  `6346d375f4c080d654829de99f4b6deb8fe2098cd0d9f99b7e5ed9a41e7777ae`
- `packages/backend/src/routes/index.test.ts`:
  `ab251ef3a9d7a99ce949977906fbf25f9aa0a49543ccd9eb1a06f6fe52dd9422`
- `red-before-tests.patch`:
  `b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
- `red-before-report.md`:
  `fc3a21e21121903a9a78a3ec009d520a94e95e2edad586270af9f9199b4e85ec`

Diffs against the frozen base:

- Product-source diff SHA-256:
  `03e510056a8a5c8daaead2bbb11b5b427ecbc00fb8487e651345f61b3d2035c9`
- Test diff SHA-256:
  `b47eb98f90431208d0ebe8bbed6f085a7269b72b8ff91e5c83ae577c0ac958a2`
