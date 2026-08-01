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


## Capabilities

### New Capabilities

- `git-status-capability-spike`: Defines the isolated two-authority feasibility harness, cross-platform parity matrix, evidence binding, and accept/reject decision gate.

### Modified Capabilities

None. Existing StackLock and collector requirements remain unchanged while Issue #132 stays blocked.

## Impact

- Adds spike-only source, fixtures, dependency lock, commands, and macOS/Linux CI coverage under an isolated ownership boundary.
- Introduces Rust/gix/capability-filesystem dependencies only to the spike; no Bun workspace package, production binary, API, schema, generated schema, record store, frontend, backend, or submodule changes are allowed.
- Every terminal result persists the same read-only governance handoff: Issue #132 is still open with recovery blocked, PR #133 remains reverted from `main`, and this spike made zero GitHub mutations. `accepted` and `rejected` are local architecture evidence only; production integration, issue closure, merge, comment, or promotion requires a separate reviewed OpenSpec change and ADR plus an explicit human approval gate.
