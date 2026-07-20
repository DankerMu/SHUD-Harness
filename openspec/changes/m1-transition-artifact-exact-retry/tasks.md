## 1. Private exact settlement

- [x] 1.1 Add the opt-in exact-failure-settlement API without changing the legacy sibling.
- [x] 1.2 Capture the first exact private generation in a one-consumer ticket.
- [x] 1.3 Coalesce same-ticket settlement through one promise.
- [x] 1.4 Preserve public missing/B/ancestor-ABA states without watchers or waits.

## 2. Failure and resource semantics

- [x] 2.1 Retry only transient unlink rejection; make proof drift irreversible.
- [x] 2.2 Separate action rejection from directory-binding finalizer rejection.
- [x] 2.3 Preserve initial-release, settlement, and final-release occurrences through the public ledger.
- [x] 2.4 Close permit, FD, capacity, mutex, binding, private unlink, and namespace cleanup paths exactly once.

## 3. Consumer migration

- [x] 3.1 Use exact settlement for owned transition-guard and cleanup-lock release.
- [x] 3.2 Use exact settlement for observed stale/recovery artifact consumption.
- [x] 3.3 Remove fresh writable terminal reobservation from guard recovery.
- [x] 3.4 Preserve typed public errors and normal record/replay behavior.

## 4. Round-2 finding closure

- [x] 4.1 C-R2-1: prove action and finalizer failures retain their physical phases.
- [x] 4.2 S-R2-1: prove restored hardlink/mode drift cannot recover on retry.
- [x] 4.3 TE-R2-2: cover false predicate, install-B-after-delete, and permit reuse.
- [x] 4.4 TE-R2-3: cover authority/binding/FD/capacity/mutex baselines and B preservation for every private failure class.
- [x] 4.5 TE-R2-4: cover concurrent same-ticket coalescing.
- [x] 4.6 Commit a delayed-watcher oracle proving zero watcher registration/event dependence.

## 5. Verification

- [x] 5.1 Establish behavior red with production source stashed and tests/evidence retained.
- [x] 5.2 Pass focused private-settlement and delayed-watcher tests.
- [x] 5.3 Pass full core-service and backend-route suites.
- [x] 5.4 Pass root check, strict OpenSpec validation, and canonical 95/95 replay verification.
- [x] 5.5 Record final diff, Zero, stash, and residue evidence.

## 6. Round-1 verified blocker closure

- [x] 6.1 Preserve early permit-admission action primary plus an ordered exact-value binding `final_release`.
- [x] 6.2 Intercept all three Node watcher families and prove the oracle with an executable negative control.
- [x] 6.3 Replace collection-only red with a base-compatible behavioral red and unchanged test-HEAD green.
- [x] 6.4 Prove consumer acceptance for explicit missing/superseded convergence and propagation for ordinary or ledger-carried failures.

## 7. Round-2 depth corrective action

- [x] 7.1 Share the wrapped promises object across `node:fs` and `node:fs/promises`, including CommonJS-visible exports.
- [x] 7.2 Actually invoke and record all 16 named, default, namespace, and CommonJS watcher access paths in the negative control.
- [x] 7.3 Mark `7127f83` as pre-fix Round-1 provenance and bind corrective green evidence to the exact current production commit plus reproducible oracle diff.
- [x] 7.4 Remove the proof-drift regression's wall-clock restoration race by retaining drift until the canonical settlement rejects.
- [x] 7.5 Reuse the captured same-ticket settlement callable and prove the rejected promise identity, proof count, and unlink count remain unchanged.
