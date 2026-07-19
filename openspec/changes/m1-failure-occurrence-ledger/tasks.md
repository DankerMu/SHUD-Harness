## 0. Preserved Round-1 Evidence

- [x] 0.1 Preserve the replayable base red patch/report and the parent
  `b6c7977...` stale-nested/deep-traversal diagnosis under tracked `evidence/`.
- [x] 0.2 Preserve all 394 base service-test declarations; only the documented
  S31/S32 ledger-equivalent names may differ.
- [x] 0.3 Persist the architecture decision proving that exact raw carrier
  identity cannot coexist with operation-owned lookup isolation.

## 1. Operation-Owned Carrier and Chronology

- [x] 1.1 Replace raw-object ledger authority and
  `registerPreservedErrorCompatibility()` aliases with a fresh immutable
  `Error` carrier for every ledger-producing fold. The raw primary MUST have no
  ledger entry.
- [x] 1.2 Add trusted fold/capture/adoption capabilities: only explicit carrier
  or ref adoption reuses history; recapturing the same raw value starts an
  independent operation.
- [x] 1.3 Keep `events` strictly sorted by unique immutable `order`; retain
  semantic primacy through `ledger.primary`, not event-vector reordering.
- [x] 1.4 Make semantic-primary access branch on ledger presence so exact
  `null`, `undefined`, falsy, private-field, and external-WeakMap-branded raw
  values round-trip unchanged.
- [x] 1.5 Prove sequential, `Promise.all` concurrent, and getter-reentrant reuse
  of one raw `Error` creates different carriers and isolated immutable ledgers;
  prove explicit nested adoption reuses each prior occurrence exactly once and
  repeated lookup is idempotent.

## 2. Bounded Hostile Observation

- [x] 2.1 Retain iterative 4096-node/8192-edge limits and add pre-charged
  limits after engine calls return: at most 8192 numeric keys per container,
  65536 total controlled prototype/property/descriptor/accessor operations,
  and 256 ordinary observation failures plus one event per exhausted budget.
- [x] 2.2 Replace unbounded `instanceof`/prototype traversal with bounded brand
  work covering cyclic and fresh-per-hop Proxy prototypes. Each exhausted
  budget records exactly one frozen observation occurrence.
- [x] 2.3 Call `Reflect.ownKeys()` at most once per observed array/container;
  after it returns, bound numeric-key filtering/sorting and throwing descriptor
  reads before ledger-controlled work. For at least 16,384 returned keys, prove
  no more than 8192 are inspected and calls/events stay within declared limits.
- [x] 2.4 Model array-brand observation as `array | non_array | failed`; on
  failure record exactly one occurrence and add no child edge/node.
- [x] 2.5 Retain N-1/N/N+1 node/edge, max-length sparse array, 25K+ chain,
  cycle, alias, accessor, and trapping-Proxy coverage; assert exactly one N+1
  budget occurrence, repeated aliases observed once, complete frozen event
  vectors, and unchanged semantic primary.

## 3. Unforgeable Typed Boundary

- [x] 3.1 Brand genuine `TaskServiceError` construction with private
  capability state; stop treating prototype traversal as authenticity.
- [x] 3.2 Provide a controlled trusted Proxy factory that privately binds the
  Proxy to a branded target. Do not expose arbitrary proxy/target registration.
- [x] 3.3 Store the verified typed target as a private carrier view. Backend and
  core consumers resolve this view before raw semantic unwrapping and do not
  touch/reclassify a one-shot Proxy twice.
- [x] 3.4 Core negative matrix: field-shaped, `Object.create(prototype)`,
  prototype-spoofing Proxy, raw `AggregateError([TaskServiceError])`, and
  ledger-like values return no trusted view. Positive matrix: real instance and
  controlled Proxy preserve exact raw semantic identity and safe target view.
- [x] 3.5 Backend matrix: every negative input maps to generic 500; positives
  assert the complete typed vector: status, category, message, `user_message`,
  `retryable`, evidence references, and recommended actions.

## 4. Accurate Release Producers and Consumer Migration

- [x] 4.1 Make `runWithPreservedRelease` and typed adapters accept/produce
  phase-aware occurrences/refs: body+release is `body, final_release`;
  fulfilled body+release+settlement is `initial_release, settlement`.
- [x] 4.2 Migrate all relevant generic TaskCard and backend compensation/release
  producers and consumers to the carrier/accessor contract.
- [x] 4.3 Migrate the shared `idempotency-service.ts` release wrapper and the
  `workspace-record-store.ts` `runWithPreservedRelease` call sites by symbol;
  preserve unrelated business state, generation tickets, and settlement logic.
- [x] 4.4 Audit manual TaskCard close/release folds and phase arrays so capture
  happens at the physical catch site and final-release errors are not labelled
  `body` or `settlement`.
- [x] 4.5 Add real-producer regression rows for all available TaskCard,
  idempotency, workspace, and backend paths, including complete phase/order
  vectors and unchanged cleanup/resource diagnostics.

## 5. Round-1 Finding Closure Evidence

- [x] 5.1 Add replayable red-before evidence for the new carrier isolation,
  bounded-work, typed-forgery, array-brand, nullish, chronological-order, and
  physical-phase tests against frozen head `1a993c89...`; then record green
  results on the repair head. No `red-proof` stash may remain.
- [x] 5.2 Run the dedicated core/backend ledger tests and every test touched by
  TaskCard/idempotency/workspace/backend migration.
- [x] 5.3 Run the full core and backend suites, typecheck,
  `npx --yes bun@1.2.19 run check`, strict OpenSpec validation,
  `git diff --check`, stash hygiene, declaration-retention comparison, and
  zero/submodule/tracked-workspace hygiene.
- [x] 5.4 Run Phase 6.2 invariant audit across shared helper roots, public
  entrypoints, read surfaces, producer/consumer boundaries, release/rollback
  paths, stale/idempotency paths, and unchanged downstream consumers; every
  matching surface is clean or explicitly out of scope with fixture basis.
- [x] 5.5 Bind exact final commands, pass/fail/skip counts, red evidence paths,
  file hashes, and source/test diff hash into tracked verification evidence.

## 6. Scope and Oracle Integrity

- [x] 6.1 No dependency, persisted schema, public HTTP payload, Zero submodule,
  private transition-ticket/generation settlement, or watcher change.
- [x] 6.2 Existing tests/spec/CI gates are not deleted or weakened to pass.
  Contract-changing assertions are replaced only where this fixture explicitly
  supersedes raw-carrier identity and implicit-adoption behavior.
- [x] 6.3 Every Round-1 confirmed finding P1/P2/S1/S2/S3/C1/C2/C3/TE1/TE2 is
  mapped to at least one executable regression and closed without silent
  deferral.
