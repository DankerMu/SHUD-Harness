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
  limits after engine calls return: at most 8192 retained numeric keys plus one
  classified/read overflow witness per container,
  65536 total controlled prototype/property/descriptor/accessor operations,
  and 256 ordinary observation failures plus one event per exhausted budget.
- [x] 2.2 Replace unbounded `instanceof`/prototype traversal with bounded brand
  work covering cyclic and fresh-per-hop Proxy prototypes. Each exhausted
  budget records exactly one frozen observation occurrence.
- [x] 2.3 Call `Reflect.ownKeys()` at most once per distinct array/container per
  fold and reuse one immutable snapshot for aliases. After it returns, retain
  only the first 8192 returned canonical numeric keys, sort only that bounded
  selected set, classify/read at most one overflow witness, and stop key
  classification. For at least 16,384 returned keys, prove no more than N+1
  numeric keys/descriptors are inspected and calls/events stay within limits.
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

## 7. Round-2 Depth Corrective Action

- [x] 7.1 Replace the parallel raw/phase/occurrence fold ABI with an
  occurrence/adoption-only protocol. Transactionally reject untrusted,
  duplicate, stale/reused, reordered, phase-invalid, cardinality-invalid, and
  incorrectly adopted entries before publishing a ledger or typed view.
  Carrier adoption MUST retain one fresh occurrence for the current physical
  catch while importing prior IDs once. Central phase grammar MUST reject later
  `body`/`initial_release`, caller-provided `observation`, and settlement after
  final release while retaining real positive vectors.
- [x] 7.2 Replace raw-value failure sentinels in backend finalizer and authority
  reconciliation, plus matching in-scope core release siblings, with explicit
  fulfilled/rejected/not-attempted outcomes. Exact `undefined`, nullish, and
  falsy rejection reasons MUST remain failures.
- [x] 7.3 Replace name/field/prototype/constructor authority-wrapper inspection
  with a core-owned closure-branded transport family. Preserve the exact outer
  semantic primary, trusted inner typed HTTP projection, and existing HTTP
  envelope; untrusted lookalikes MUST stay generic and no caller constructor or
  getter may run.
- [x] 7.4 Count actual canonical numeric keys independently from returned-key
  position. Select the first N returned numeric keys and emit the bounded set in
  numeric order; do not scan an adversarial Proxy tail for globally lower
  indices. Cover N-1/N/N+1 with `length`, strings, and symbols reordered; assert
  one `ownKeys` call per aliased container, complete edges, exact frozen vectors,
  strictly increasing unique order, and unchanged semantic primary. Restore
  independent edge and numeric occurrences for a normal N+1 present-descriptor
  array without fabricating edge evidence for an unclassified/absent tail.
- [x] 7.5 Add replayable red evidence for mismatched/stale occurrence entries,
  untrusted/custom authority transports, exact `undefined` cancellation and
  reconciliation, deceptive numeric ordering, and the strengthened hostile
  oracle. The red run MUST fail for intended behavior and leave no stash or
  temporary worktree.
- [x] 7.6 Migrate every occurrence-bearing TaskCard, backend, idempotency, and
  workspace release caller atomically. Preserve private generation settlement,
  unrelated business state, persisted schemas, frontend, dependencies, Zero,
  and the public HTTP payload.
- [x] 7.7 Correct dedicated static declaration evidence to the reproducible
  `test()` count convention, report parameterized runtime cases separately,
  and bind final commands/counts/hashes to the repaired semantic HEAD.
- [x] 7.8 Run dedicated and real-producer focused tests, full core/backend,
  typecheck, root `check`, strict OpenSpec, diff/stash/submodule/Zero/workspace
  hygiene, then complete a full-inventory invariant audit before Round 3.

## 8. Round-3 Split Child A2 — Observation Bounds

- [x] 8.1 Enforce the reconciled first-N-plus-one-witness numeric contract and
  update prior lowest-N tests without changing historical replay-patch bytes.
- [x] 8.2 Memoize each distinct `errors` container inspection once per fold;
  reuse the immutable snapshot across parent aliases while charging each edge.
- [x] 8.3 Preserve exact semantic-primary Error identity independently of the
  4096-node public graph budget.
- [x] 8.4 Capture red-first regressions for a 65,536 numeric-key Proxy, a shared
  mutating Array Proxy, and a late vector semantic primary; cover N-1/N/N+1,
  descriptor failures, frozen vectors, budget events, and alias edge fan-out.
- [x] 8.5 Run dedicated, full core/backend, typecheck, root check, strict
  OpenSpec, and incremental hygiene verification on the final A2 head.

## 9. Round-3 Split Child A3 — Tracked Evidence Closure

- [x] 9.1 Persist the definitive Phase 6.2 invariant inventory under tracked
  OpenSpec evidence, including every required surface, the A1/A2 semantic
  heads, verification results, and residual platform limits.
- [x] 9.2 Replace the final ignored `.workplans` audit reference with the
  tracked report so a fresh clone can resolve every canonical evidence path.
- [x] 9.3 Enumerate all 13 preserved replay-artifact whitespace lines: seven in
  the Round-1 Phase 6.2 patch and six in the Round-2 backend patch. Remove all
  unrelated trailing whitespace so range-wide hygiene reports only those
  byte-preserving exceptions.
- [x] 9.4 Bind final source/test diff hashes, file hashes, replay artifact
  hashes, replay preflight commands, strict OpenSpec, and final-head hygiene to
  the A1/A2 semantic stack without using `.workplans` as canonical evidence.
- [x] 9.5 Replace the inline replay lifecycle with one tracked executable
  verifier whose exact target and cleanup authority exist before temporary
  state. Reject collisions without touching foreign paths, latch the first
  failure/signal before cleanup command boundaries, and prove normal,
  post-create, partial, add/patch, dirty/locked/missing, single/double-signal,
  verifier/harness collision, and self-test-harness paths with a deterministic
  22-case zero-residue matrix.
