## Why

An idempotency transition artifact can fail after the store has already moved its exact physical generation from the public pathname into a private mutation namespace. Restoring that generation publicly and observing it again loses the original authority boundary and can race with a successor generation.

## What Changes

- Add an opt-in conditional delete that captures a private, one-generation settlement ticket after exact isolation.
- On post-isolation failure, settle only that private generation and never restore or re-observe the public pathname.
- Coalesce repeated settlement of one ticket through one promise and release the permit, descriptor, capacity, mutex, and directory binding exactly once.
- Make proof drift irreversible; retry only transient unlink failures.
- Use the opt-in operation for idempotency transition guards and cleanup locks while keeping the generic conditional-delete behavior unchanged.
- Preserve phase-tagged failures through the existing public occurrence ledger from `m1-failure-occurrence-ledger`.

## Out of Scope

- Changes to the public failure-ledger implementation or its backend adapter.
- TaskCard generation policy, persisted schemas, backend production routes, dependency manifests, `zero/`, and M3-or-later work.

## Capability

- `transition-artifact-exact-settlement`
