## Why

Issue #132 cannot safely finish its cross-platform dirty-state observer with the current Git CLI seam: macOS cannot traverse an inherited directory descriptor through `/dev/fd`, so Git cannot consume both the held checkout directory and the frozen Git-state directory without converting one authority back to a pathname. PR #133 was reverted from `main` after this P1 was confirmed; a bounded, falsifiable spike is required before choosing or shipping a native dependency.

## What Changes

- Add an isolated Rust/gix feasibility spike that receives a held checkout-directory capability plus an immutable, bounded Git-state payload and attempts dirty-state observation without reopening either authority by ambient pathname.
- Add one frozen 174-row adversarial catalog, executed exactly once on macOS and once on Linux, covering tracked, staged, untracked, ignore/attribute/config, index/split-index, linked-worktree and nested-repository states, together with replay, collection-wide protection, helper-nonexecution, resource, cleanup, and determinism oracles. A one-to-one crosswalk gives every missing #132 evidence-floor case its own mandatory row; there are no optional, skipped, platform-conditional, merged-floor, or implementation-selected rows.
- Separate row observations, row verdicts, harness validity, and the terminal technology decision. A valid complete experiment produces deterministic `accepted` or `rejected`; missing/corrupt evidence, identity drift, supply-chain incompleteness, or repository regression/isolation failure is an invalid harness run with no terminal decision and must be rerun.
- Persist a bounded, reviewable, content-addressed raw evidence bundle and a separately normalized decision projection. `accepted` requires every mandatory row on both platforms plus every decision-bearing supply, reproducibility, repository, and governance gate; a technical row failure records `rejected` and forbids pathname, Linux-only, or weakened-contract fallback.
- Keep the spike outside production packages and public StackLock seams. It does not restore PR #133, change Issue #132 runtime behavior, add a production Rust toolchain, or alter the StackLock schema.
- The current Issue #175 delivery is the first #172 replacement child: it binds only post-admission `openat`/`fstatSync`/`readSync`/`closeSync` operations to retained or verification descriptor provenance and proves fd `0` and Linux `AT_FDCWD` mutations fail before side effects; delegate topology, Worker lifecycle, and final evidence remain dependency-ordered follow-ups.
- Human-selected ceiling split Issue #185 originally replaced PR #184's runtime half. PR #187's second ordinary-loop gate then split that runtime family again: prerequisite #188 owns close-state/no-raw semantics, #189 owns focused runtime causal proof, and #190 owns the installer/type boundary. #189 and #190 depend on #188; Issue #186 remains blocked until all three complete and still owns complete acquisition/interleaving/callback/durable-evidence proof.

## Issue #185 descriptor mediation replacement-family contract

PR #184 proved that the #175 handoff needs a private runtime trust signal, but
its fifth review round confirmed defects in mediator result handling and
terminal cleanup. Issue #185 is the runtime replacement slice. It adds exactly
one runtime export, `installDescriptorPrimitiveMediator`, and exactly two
erased type exports:

```ts
type DescriptorPrimitiveInvocation = () => unknown;
type DescriptorPrimitiveMediator = (
  operation: DescriptorOperation,
  invoke: DescriptorPrimitiveInvocation
) => undefined;
```

The installer is a frozen, non-constructible, module-instance one-shot callable.
Runtime validation precedes latching. It exposes no registry, raw callable,
raw result/error, lifecycle control, getter, reset, uninstall, replacement, or
general authority-enter path.

The private owner mediates only the raw `openSync`, already-resolved FFI
`openat`, `fstatSync`, `readSync`, and `closeSync` callsites. Validation,
denials, FFI loading/symbol resolution, descriptor issuance, caller hooks, and
lifecycle settlement remain outside each callback. The invocation closure is
synchronous, callback-scoped, exactly once, and returns only `undefined`.
Every public `ContractCapabilities` entry rejects reentry before observable
work while a primitive callback is active.

A raw invocation that started before mediator return owns the original
capability result. The exact raw return or thrown object remains private and
authoritative over any later mediator throw, repeated invocation, or
non-`undefined` return; those values are ignored without property access after
raw start. No raw start yields the stable missing/async/expired or original
pre-invocation callback failure and zero raw calls. A non-`undefined` return
before invocation is the stable async protocol error. The owner expires the
invocation before classification and MUST NOT inspect or assimilate Promise,
thenable, `constructor`, `Symbol.species`, or Proxy-controlled properties.

The mediator is a trusted synchronous producer. It MUST return exactly
`undefined`; returning or throwing a Promise is outside this contract and the
producer MUST handle its own rejection before exposure. Bun 1.2.19 has no public
species-bypassing operation that can set a hostile Promise's internal handled
state, so the descriptor owner neither observes nor claims to settle arbitrary
Promise values. This does not weaken raw authority: once `invoke` starts, the
saved raw outcome, issuance, and terminal settlement still complete without
reading the mediator's later value.

For `close_sync`, every no-raw outcome restores direct retryability; a raw start
is terminal. Ingress alone consumes the private no-raw classification, at most
twice total, while strongly retaining the owner set anchored before the first
close. A second persistent refusal atomically poisons the module-instance
ingress boundary and snapshots every unsettled live owner; all later
direct/checker admissions fail before mediation, raw work, or fd allocation.
Before any ingress-owned raw close starts, the owner rechecks terminal poison
after every untrusted pre-raw callback, including `onCloseAttempt`. If nested
work poisons ingress after a final retained/root raw close starts, every
`closeFault` completion—normal false, injected-fault true, or throw—must
observe poison before success- or catch-settlement can release the owner. The
outer ingress terminates, performs no second raw close or later OS work, and
preserves every poison snapshot after active-context deletion. This poison is
a cleanup failure: schema-invalid is selected only without an earlier primary;
an existing primary result/error remains authoritative.

The runtime proof is process-isolated: all five primitives cover raw
return/throw followed by a pre-handled rejected Promise, ordinary thenable,
Proxy, or thrown value, proving raw authority/resource closure and zero
property inspection; a pre-invocation non-`undefined` row proves stable ASYNC
with zero raw calls. Direct/checker receipts cover
representative paths; direct/direct, direct/checker, and checker/direct nested
close interleavings prove zero post-poison raw operations and fixed owner/fd
cardinality. The gate-split replacements keep every mutation process-local:
#188 owns exact no-raw classification plus post-raw nested-poison settlement,
#189 owns the remaining focused runtime causal-proof matrix, and #190 owns
installer runtime-arity and erased-type exactness. None owns a reusable causal-red
script, complete transcript, manifest, or durable receipt. Issue #186
exclusively owns those artifacts plus the complete copied-tree acquisition
scanner, suspended `afterAdmission` matrix, and all-`observe` callback proof.
After #188/#189/#190 and #186, #176's exact allowlist is the union of #175's
five existing exports and the installer plus two erased types; no prior handoff
entry is removed.

## Capabilities

### New Capabilities

- `git-status-capability-spike`: Defines the isolated two-authority feasibility harness, cross-platform parity matrix, evidence binding, and accept/reject decision gate.

### Modified Capabilities

None. Existing StackLock and collector requirements remain unchanged while Issue #132 stays blocked.

## Impact

- Adds spike-only source, fixtures, dependency lock, commands, and macOS/Linux CI coverage under an isolated ownership boundary.
- Introduces Rust/gix/capability-filesystem dependencies only to the spike; no Bun workspace package, production binary, API, schema, generated schema, record store, frontend, backend, or submodule changes are allowed.
- Every terminal result persists the same read-only governance handoff: Issue #132 is still open with recovery blocked, PR #133 remains reverted from `main`, and this spike made zero GitHub mutations. `accepted` and `rejected` are local architecture evidence only; production integration, issue closure, merge, comment, or promotion requires a separate reviewed OpenSpec change and ADR plus an explicit human approval gate.
