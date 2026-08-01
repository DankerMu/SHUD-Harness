## Why

Issue #132 cannot safely finish its cross-platform dirty-state observer with the current Git CLI seam: macOS cannot traverse an inherited directory descriptor through `/dev/fd`, so Git cannot consume both the held checkout directory and the frozen Git-state directory without converting one authority back to a pathname. PR #133 was reverted from `main` after this P1 was confirmed; a bounded, falsifiable spike is required before choosing or shipping a native dependency.

## What Changes

- Add an isolated Rust/gix feasibility spike that receives a held checkout-directory capability plus an immutable, bounded Git-state payload and attempts dirty-state observation without reopening either authority by ambient pathname.
- Add one frozen 174-row adversarial catalog, executed exactly once on macOS and once on Linux, covering tracked, staged, untracked, ignore/attribute/config, index/split-index, linked-worktree and nested-repository states, together with replay, collection-wide protection, helper-nonexecution, resource, cleanup, and determinism oracles. A one-to-one crosswalk gives every missing #132 evidence-floor case its own mandatory row; there are no optional, skipped, platform-conditional, merged-floor, or implementation-selected rows.
- Separate row observations, row verdicts, harness validity, and the terminal technology decision. A valid complete experiment produces deterministic `accepted` or `rejected`; missing/corrupt evidence, identity drift, supply-chain incompleteness, or repository regression/isolation failure is an invalid harness run with no terminal decision and must be rerun.
- Persist a bounded, reviewable, content-addressed raw evidence bundle and a separately normalized decision projection. `accepted` requires every mandatory row on both platforms plus every decision-bearing supply, reproducibility, repository, and governance gate; a technical row failure records `rejected` and forbids pathname, Linux-only, or weakened-contract fallback.
- Keep the spike outside production packages and public StackLock seams. It does not restore PR #133, change Issue #132 runtime behavior, add a production Rust toolchain, or alter the StackLock schema.
- The current Issue #175 delivery is the first #172 replacement child: it binds only post-admission `openat`/`fstatSync`/`readSync`/`closeSync` operations to retained or verification descriptor provenance and proves fd `0` and Linux `AT_FDCWD` mutations fail before side effects; delegate topology, Worker lifecycle, and final evidence remain dependency-ordered follow-ups.
- Maintainer-approved Issue #183 inserts one #175-owned descriptor-primitive mediation seam before #176: a one-shot installer scopes trust only around the five exact raw primitives, never around validation or caller hooks. This is the explicit replacement for PR #182's rejected `ContractCapabilities` prototype rewrite/global-depth workaround; the registry and class internals remain private.

## Issue #183 descriptor primitive mediation contract

PR #182's rejected depth-based approach demonstrated that the #175 handoff has
no runtime trust signal: its reusable values are static policy data or erased
types. Prewarming does not preserve raw bindings across `mock.module`, and a
consumer-owned `ContractCapabilities` prototype rewrite would cross the
descriptor-owner boundary and let caller callbacks inherit raw authority.

Issue #183 therefore remains a #175-owned, spike-local prerequisite to #176. It
adds exactly one runtime export,
`installDescriptorPrimitiveMediator`, and exactly two erased type exports:

```ts
type DescriptorPrimitiveInvocation = () => unknown;
type DescriptorPrimitiveMediator = (
  operation: DescriptorOperation,
  invoke: DescriptorPrimitiveInvocation
) => unknown;
```

The installer is a frozen, non-constructible callable with only its standard
`name` and `length` own data properties. It is module-instance one-shot: runtime
validation precedes latching, so an invalid installer does not consume the
one-shot slot; the first valid installer succeeds; every later installer throws
`CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ALREADY_INSTALLED`. No getter, reset,
uninstall, replacement, registry view, raw callable, raw result channel, or
general authority-enter path is exported or reachable from the installer value.

### Primitive window and outcome ownership

The private owner mediates only the five raw primitive callsites. Lazy `dlopen`
and FFI symbol lookup remain outside the callback.

| Canonical operation | Raw primitive inside the window | Required work outside the window |
|---|---|---|
| `open_root` | `openSync(root, DIRECTORY_OPEN_FLAGS)` | Root/phase validation and descriptor issuance |
| `openat` | Resolved FFI `openat` callable | Parent, child, phase, flags, and lifecycle validation; loader/symbol resolution; issuance |
| `fstat_sync` | `fstatSync` | Handle resolution and stat-derived record transition |
| `read_sync` | `readSync` | Handle, phase, kind, flags, and bounded-range validation |
| `close_sync` | `closeSync` | Owner resolution, hook order, terminal settlement, and existing error precedence |

The module has one shared state machine:

| State / event | Required behavior |
|---|---|
| `inactive`, no installer | The owner invokes the raw primitive directly and preserves all prior #175 behavior. |
| `inactive`, installed mediator | The owner opens one callback window and passes the canonical operation plus an ephemeral invocation closure. |
| Callback window active | Every public `ContractCapabilities` entry—`sealAdmission`, both opens, `markRetained`, `stat`, `readRetained`, `close`, and `rejectForbidden`—rejects immediately with `CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_REENTRY`. This happens before validation, denial emission, lifecycle work, or caller hooks. |
| First synchronous `invoke()` | The owner starts at most one raw primitive, records its exact return or thrown error privately, and returns `undefined` to the mediator. Raw numeric fds, stats, byte counts, and every other raw result remain unavailable to mediator code. |
| A second synchronous `invoke()` | That invocation itself throws `CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_REPEATED` and starts no extra raw primitive. It has the same inner error whether mediator code catches it or lets it escape. |
| Callback returns after the first raw start | The captured raw result or raw error is authoritative for the original capability API. A mediator throw, thenable, or uncaught/caught repeated-call error after that start cannot replace the result, mask the raw error, skip issuance, or orphan the raw resource. |
| No primitive started | A synchronous omission throws `CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING`; a declared-async or ordinary thenable return throws `CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_ASYNC`; a closure used after return throws `CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_EXPIRED`. All three paths make zero raw calls. A mediator's own pre-invocation throw remains its callback error, but `close` still restores retryability because no raw close began. |
| Callback return before untrusted result inspection | The owner expires the invocation closure immediately after normal mediator return and before reading `then` or any Proxy-controlled return-value property. The shared callback/reentry state remains active through that classification, so getter-started public entries still reject as reentry; a raw outcome remains authoritative only when its invocation began before return. |

The owner MUST NOT inspect callable `constructor`, `Symbol.toStringTag`, or
`Object.prototype.toString` metadata before applying an installed mediator. A
callable `Proxy` is valid when it obeys the same synchronous contract.

### Lifecycle, denial, and callback boundary

All validation and denial paths remain before mediation. Invalid root or phase,
unproven parent or stat handle, invalid flags, read phase/range, and close owner
must produce the existing descriptor denial before a mediator or raw primitive
is reached. This preserves the private registry, generation, owner, phase,
flag, kind, and range boundary.

For `close_sync`, the owner saves the live descriptor state and makes it
temporarily unavailable while close-attempt hooks run. If no raw `closeSync`
begins—because the mediator omitted, threw before invocation, returned a
thenable, or deferred use—the original state is restored and the caller can
retry. Once raw close begins, the descriptor remains terminal exactly as #175
requires, including raw-close failure, injected close fault, and primary versus
cleanup error precedence.

Ingress retains each close owner until settlement. A private, non-exported
retryable-close error classification distinguishes `no_raw_retryable` from a raw-terminal close:
root and child rollback, verification cleanup, retained cleanup, and the
checker path retry only the former, at most twice total. A one-time omission,
throw, thenable, or deferred invocation therefore reaches one mediated raw
close on retry; persistent refusal terminates after that fixed bound with the
existing primary error winning over cleanup failure, or an explicit
`CONTRACT_SCHEMA_INVALID` when cleanup is the only failure. No retry bypasses
the mediator or performs an unmediated raw close.

Denial, close-attempt, close-fault, authority-violation, `afterAdmission`,
`observe`, and `beforeCleanup` callbacks enter only after the prior primitive
window is inactive. Eligible descriptor work started by any such callback opens
a distinct callback window whose prior state is also inactive. The direct
`readBoundedFile` path and `runCheckForTest` checker ingress are both part of
this proof; this does not broaden #176's ownership.

### Issue #183 invariant and evidence matrix

| Surface | Invariant | Required regression evidence |
|---|---|---|
| Installer | Invalid → valid → valid ordering, frozen/non-constructible standard own and inherited surface, and no hidden control property | Process-isolated descriptor/prototype receipt plus AST mutations for `reset` and pre-freeze `setPrototypeOf` |
| Primitive ownership | One sole top-level lexical helper owns the five callsites; every `BindingName` shadow and callable alias is rejected; resolved `openat` receives the exact parent fd, NUL child bytes, flags, and issued-result relation | Binding-aware AST mutations for destructuring, extra alias call, wrong argument, and wrong flag plus the process tuple receipt |
| Raw calls | Every `openSync` is counted with its complete argument tuple; each canonical primitive runs once | Full retained-chain receipt and an extra non-root `openSync` source mutation |
| Reentry | Every public capability family rejects before observable work throughout each of the five outer primitive windows | Process-isolated five-window table with every public-entry reentry, zero denial/lifecycle/hook delta, and zero nested raw calls |
| Outcome precedence | A raw return/error owns post-invoke throw, thenable, and repeated-call outcomes only when the raw invocation began before mediator return | Getter and Proxy-return matrix over all five primitives, with expired closure, reentry, async, and zero-raw assertions |
| Close settlement | No raw close restores retryability; attempted raw close remains terminal; ingress retains owner through bounded retry | Omission/throw/thenable/deferred ingress matrix for root, child, verification, retained, and checker owners, plus persistent-refusal bound |
| Invalid inputs | Installed mediation emits exactly one frozen existing denial before mediator or raw work for each invalid row | Table-driven exact denial-event receipt with zero mediator invocations and zero raw calls |
| Caller callbacks | Existing four `CapabilityHooks` plus ingress `afterAdmission`, `observe`, and `beforeCleanup` enter inactive; nested eligible work starts inactive | Process-isolated hook and real ingress/checker receipts |
| Same-fd replacement | Old closed capability stays stale when a new generation reuses the same raw fd | Forced same-number close/reopen process fixture |

The handoff remains narrow: #176 may import only the runtime installer and the
two erased types above. It may not import the registry, raw records, raw
callables, lifecycle implementation, or `ContractCapabilities` for prototype
rewriting. Dependency order remains #175 → #183 → #176 → #177 → #178.

### Required Darwin preparation, causal red proof, and green receipt

These are required commands for the orchestrator at the fixed clean head, not
claimed receipts. On Darwin, prepare dependencies from the frozen lockfile
before any test or type proof:

```sh
npx --yes bun@1.2.19 install --frozen-lockfile
```

The final causal red proof replaces only the descriptor owner with its pre-seam
base (`e70a0853ae6b1d6a3fd80ffe92ca98d7926eede8`), retains every current focused
test, preserves the raw red transcript outside the repository, restores the
exact fixed source even on failure, proves a clean worktree, and only then runs
green:

```sh
set -eu
SOURCE=spikes/git-status-capability/contracts/lib/capabilities.ts
PRE_SEAM=e70a0853ae6b1d6a3fd80ffe92ca98d7926eede8
FIXED_SOURCE="$(mktemp -t issue183-capabilities.XXXXXX)"
RED_TRANSCRIPT="${TMPDIR:-/tmp}/issue-183-pre-seam-red.$$.log"
cp "$SOURCE" "$FIXED_SOURCE"
restore_source() {
  cp "$FIXED_SOURCE" "$SOURCE"
  rm -f "$FIXED_SOURCE"
}
trap restore_source EXIT HUP INT TERM
git show "${PRE_SEAM}:${SOURCE}" > "$SOURCE"
set +e
npx --yes bun@1.2.19 test \
  spikes/git-status-capability/contracts/tests/authority-descriptor-structural.test.ts \
  spikes/git-status-capability/contracts/tests/authority-descriptor-mediation.test.ts \
  spikes/git-status-capability/contracts/tests/source-ingress.test.ts > "$RED_TRANSCRIPT" 2>&1
red_status=$?
set -e
cat "$RED_TRANSCRIPT"
test "$red_status" -ne 0
restore_source
trap - EXIT HUP INT TERM
git diff --exit-code -- "$SOURCE"
test -z "$(git status --porcelain)"
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests/*.test.ts
npx --yes bun@1.2.19 x tsc -p spikes/git-status-capability/contracts/tsconfig.descriptor-authority.json
```

The transcript must show the current focused assertions failing against only
the pre-seam owner; neither the command nor this proposal invents a status,
count, or receipt.

### Required Linux read-only evidence command

Prepare `DEPS` with the same frozen-lockfile command in a disposable writable
checkout of this exact source, then mount that resulting dependency directory
as the sibling `/node_modules`. The source worktree is mounted read-only at
`/repo`, never with dependencies nested at `/repo/node_modules`:

```sh
REPO=/absolute/path/to/SHUD-Harness-issue-183
DEPS=/absolute/path/to/node_modules
docker run --rm \
  --mount type=bind,src="$REPO",dst=/repo,readonly \
  --mount type=bind,src="$DEPS",dst=/node_modules,readonly \
  --workdir /repo \
  --env NODE_PATH=/node_modules \
  oven/bun:1.2.19 \
  sh -lc '
    bun test spikes/git-status-capability/contracts/tests/*.test.ts &&
    bun /node_modules/typescript/bin/tsc \
      -p spikes/git-status-capability/contracts/tsconfig.descriptor-authority.json
  '
```

This proposal records runnable procedures only. The orchestrator records their
actual Darwin/Linux red and green receipts after execution.

### Required OpenSpec and hygiene checks

After the restored green receipt, the orchestrator runs:

```sh
npx --yes openspec validate m2-capability-observer-spike --strict --no-interactive
git diff --check
git diff --exit-code origin/main -- openspec/changes/m2-capability-observer-spike/design.md
git -C zero diff --quiet
test -z "$(git status --porcelain)"
test -z "$(git stash list | grep red-proof || true)"
```

These checks also remain procedures, not claimed results.


## Capabilities

### New Capabilities

- `git-status-capability-spike`: Defines the isolated two-authority feasibility harness, cross-platform parity matrix, evidence binding, and accept/reject decision gate.

### Modified Capabilities

None. Existing StackLock and collector requirements remain unchanged while Issue #132 stays blocked.

## Impact

- Adds spike-only source, fixtures, dependency lock, commands, and macOS/Linux CI coverage under an isolated ownership boundary.
- Introduces Rust/gix/capability-filesystem dependencies only to the spike; no Bun workspace package, production binary, API, schema, generated schema, record store, frontend, backend, or submodule changes are allowed.
- Every terminal result persists the same read-only governance handoff: Issue #132 is still open with recovery blocked, PR #133 remains reverted from `main`, and this spike made zero GitHub mutations. `accepted` and `rejected` are local architecture evidence only; production integration, issue closure, merge, comment, or promotion requires a separate reviewed OpenSpec change and ADR plus an explicit human approval gate.
