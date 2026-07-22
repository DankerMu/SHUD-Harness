# Definitive Phase 6.2 invariant audit

Invariant audit: clean

## Binding and inputs

- Issue base: `5a450a97f2a474af2f4db26bd9ee198adb7395ec`.
- Round-3 split base: `1aadd5c613eb383f9e65079066e2459876038811`.
- Child A1 semantic head: `ca67f6fcc2588d719465ee28be791aa80d17660e`.
- Child A2 and final semantic head:
  `a070092e02568125b8c0e96810f20dfbb85bbbe3`.
- Fixture inputs: `design.md`, `specs/failure-occurrence-ledger/spec.md`,
  `tasks.md`, `evidence/architecture-decision.md`, and
  `evidence/round-3-split-plan.md`.
- Historical audit result: the Round-2 full-inventory audit was clean but was
  stored only under ignored `.workplans`. This tracked report preserves its
  input/result and revalidates the inventory after A1 and A2. `.workplans` is
  not a canonical input to this report.

## Invariant Surface Inventory

- Shared helper roots: clean. The compensation helper owns occurrence capture,
  transactional one-shot adoption, graph budgets, per-fold container outcome
  caching, exact semantic-primary lookup, and private authority transport.
  The TaskServiceError adapter shares one entry/vector typed-classification
  path and resolves generic-carrier adoption without a second hostile Proxy
  prototype classification.
- Public entrypoints: clean. Ledger, event, graph, terminal-phase,
  semantic-primary value/Error, capture/adopt, and typed preservation exports
  are reachable through the service, domain, and core roots as specified. The
  internal entry semantic-primary authority helper is not exported publicly.
- Read surfaces: clean. Semantic primary, ordered physical events,
  ordered-distinct projection, graph nodes, observation failures, and terminal
  physical phase retain separate immutable views and exact identities.
- Write/delete/overwrite surfaces: clean and behaviorally unchanged. The
  shared helper performs no persistent IO; full idempotency/workspace tests
  retain path, inode, authority, cleanup, retry, and capacity invariants.
- Staging/publish/rollback surfaces: clean. TaskCard publication,
  idempotency finalization/reconciliation, workspace rollback/cleanup, and
  backend finalization use exact occurrence/phase authority. Observation never
  substitutes for release or settlement, and settlement cannot follow final
  release.
- Producer/consumer evidence boundaries: clean. Physical catches mint or reuse
  exactly the required occurrence; adoption imports prior IDs once and adds one
  fresh catch. Core typed/generic adapters and the backend envelope preserve
  exact outer semantic identity and privately authenticated inner typed data.
- Stale-state/idempotency boundaries: clean. Snapshot/preflight precedes claim;
  failed preflight does not consume a valid adoption. Duplicate, stale,
  reordered, cardinality-invalid, phase-invalid, or forged entries fail
  transactionally. Per-fold caches do not authorize later folds.
- Unchanged downstream consumers: clean. Frontend, schemas, WebSocket, policy
  gate, tool registry, GLM provider, dependency manifests, persisted payloads,
  Zero, and read-only submodules have no semantic change from the children.

## Round-3 finding closure matrix

- A1: ST-R3-01, ST-R3-02, ST-R3-04, CT-R3-01, and CT-R3-02 are closed by
  transactional vector preflight/claim, opaque adoption ownership, combined
  chronology validation, terminal physical-phase authority, and reuse of the
  physical rejection occurrence.
- A2: CT-R3-03, CT-R3-04, and PERF-R3-01 are closed by first-N plus one-witness
  numeric inspection, one immutable per-container snapshot, exact
  semantic-primary Error caching beyond the 4096-node public graph, and
  bounded alias replay.
- A3: TE-R3-01 is closed by this tracked inventory, the final semantic
  SHA/tree/hash binding in `verification.md`, and exact 7+6 replay-artifact
  whitespace accounting in `replay-whitespace-exceptions.md`.

## Executed verification bound to the final semantic head

- Dedicated core/backend ledger suite: 41 pass, 0 fail, 520 assertions.
- Full core-service suite: pass with 443 tests plus 5 platform-conditioned
  skips and no failure.
- Full backend API suite: 163 pass, 0 fail.
- Typecheck and root `check`: exit 0.
- Strict OpenSpec: exit 0; change valid.
- Incremental implementation/spec/test `git diff --check`: clean.
- Stash, submodule, tracked-workspace, and Zero-pin hygiene: clean; Zero is
  `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- A1 Round 2: clean at `ca67f6f` after three verified Round-1 findings were
  repaired.
- A2 post-repair Phase 6.2 audit: clean. A2 six-lens Round 2: clean with zero
  verified findings. A2 independent gap sweep: clean.

## Residual limits

- JavaScript cannot preempt a non-returning Proxy trap or bound engine-internal
  allocation before `Reflect.ownKeys()` returns. All work after engine return
  is charged before execution and bounded by the fixture.
- The 13 single-space replay context lines are byte-preserving historical
  artifacts, not product-source whitespace. They are fully enumerated and
  hash-bound; all other range whitespace is clean.

Remaining findings: none.
