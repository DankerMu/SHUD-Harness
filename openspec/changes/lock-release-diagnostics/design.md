# Design

## Governing invariant

Metadata removal happens only while this instance owns the permanent kernel guard; every release attempt closes its descriptor even if removal fails. No failure recovery admits a second writer or changes index bytes/the coordination inode.

## Decisions

Policy C is one existing automatic unlink attempt per release, no retry API, no timer, no automatic live-self recovery. `StateIndexStore.close` keeps its identical memoized promise and closes mutation admission/drains accepted work as before. Availability may remain blocked until operator recovery or original-host exit.

`StateLock.release` captures unlink and close outcomes separately, preserving unlink-before-close and success-path behavior. Only successful close authorizes “kernel guard released”; failed close reports uncertainty. Diagnostics identify stateDir, lock path and failing operation/code. Preserve original errors by cause/aggregate, with both failures reachable when both occur. Do not treat ENOENT as success or falsely claim existing metadata when removal reported absence; distinguish removed, removal failed/residue possible, and absent as supported by the operation result. Do not add filesystem reads solely to make a stronger diagnostic claim.

After acquiring the guard, a matching current-process pid/start still rejects, but names suspected release residue and required operator verification. Kernel contention still uses the existing holder/publication-contention diagnostic; matching foreign live identity, malformed metadata, missing primitives and uncertain identity keep their existing fail-closed decisions. Do not infer the historical cause of arbitrary self metadata with certainty.

`StateIndexStore` initialization catch retains the original validation/publication error and release error in one aggregate when both fail; ordinary initialization errors remain unchanged. Existing outer Cordis/registry error reporting remains sole logger: no new lower-layer logging, no duplicate handlers. No public signature change or error-suppression fallback.

Concrete error shape: a single release failure is contextual Error with the original failure as cause; two failures use AggregateError with unlink first and close second, both original objects retained. Initialization double failure aggregates original initialization first and contextual release second, with the initialization error as cause and primary message context. Original Error objects are not mutated. No separate generic error framework or collector dependency is introduced into lock ownership.

## Operator recovery

Preferred: restore filesystem permissions/health, stop the original host and prevent concurrent starts, then restart through normal stale-owner acquisition. For manual metadata removal, first stop admissions/hosts and verify no live registry owns the stateDir; acquire and retain the same permanent kernel guard, re-read/verify the metadata owner, remove only that confirmed residue while still holding exclusion, then release the guard and start one instance. A check-then-delete without exclusion is not safe. Never remove/rename `.lock-guard`, or hand-edit/delete either index. Unknown close/ownership state requires host exit or further verification, never blind deletion. Repeated close after permissions improve still returns the original rejection.

## Sibling surfaces and evidence

Disposal with empty and queued index work; index-initialization failure cleanup; outer registry-constructor cleanup; live-self versus real foreign/busy holder; ordinary success/stale takeover. Keep shared lifecycle admission/drain, non-SHUD parent behavior and process precision unchanged.

Fault tests first: unlink EACCES on disposal and initialization; diagnostic fields and original errors; one outer report; unchanged index bytes and guard dev/ino; independent child proves guard is acquirable while registry apply still refuses live metadata; after safe recovery apply succeeds with original valid indexes. Invalid-index case retains its invalid bytes until the fixture explicitly restores them as a separate recovery precondition. Double unlink/close failure preserves both errors and unknown guard; close-only failure is likewise uncertain. Repeated close does not repeat removal/logging.

Real Darwin built-store/registry smoke uses an owned temp stateDir with nonempty indexes: chmod0500, release failure, native child guard proof, restored permissions and safe metadata recovery, reacquisition with unchanged contents/inode. Linux CI runs deterministic injected cases and native child probes; do not claim real chmod proof on a platform/user that bypasses permissions. Original issue permission evidence is ground truth, not rerun for confirmation.

## Scope and documentation

Update pending M2 lock requirement failure wording/design as required by issue, plus current lifecycle instruction source and relevant runtime docs; render generated instructions. Preserve M2 task 8.1's existing checked text and historical evidence byte-for-byte, appending a dated policy-C/failure verification entry rather than rewriting the old acceptance record. Independent delta uses a unique new requirement so later M2 archive adds its broader requirement without collision. M2 remains pending PI acceptance. No retry mechanism, nonce, lock library, stronger pid-generation claim, SHUD signal/collection change or gate relaxation.
