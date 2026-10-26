# Design

## Context and authority

PI comments 6397950076 and 6405181313 govern issue #344: numeric values are recomputable observation windows, not solver-runtime bounds or fixed-precision measurements. See proposal.md for scope. No new persistent fields, configuration or dependencies; process identity and timestamps retain their existing owners.

The sole formula is in shud-collect.ts. Original submission and R3/R5 adoption both currently install CompletionReceipt, and complete() deletes that receipt before later automatic collect. Receipt presence therefore cannot establish original execution or survive the settlement-to-collection gap. The collector's valid committed-record early return precedes generation and remains authoritative.

## Decisions

### 1. Meaning and eligibility

For a newly generated record, a number means the original submitting registry observed both the accepted native start identity and its own successful terminal transition. It equals `(Date.parse(finished_at) - Date.parse(started_at)) / 1000` from that run's validated timestamps. finished_at remains settlement observation, never solver exit time. The window may include lstart clock bias, scheduling/detection delay and online cancellation grace. There is no claimed finite error bound, solver-runtime upper bound or fabricated millisecond precision; the 1032ms historical snapshot is not a universal bound.

Eligible endings are valid numeric exit evidence or a locally controlled cancellation whose existing quiescence gate permits terminal publication. Lost execution or invalid/unreadable exit evidence cannot create a trustworthy duration observation. Recovered R2/R6/R7/R8 and R3/R5 adoption cannot mint original-execution evidence, even when a new registration/receipt exists. R2 already has no start timestamp and remains null.

### 2. Original identity on the existing receipt, terminal handoff owned by the dispatcher

Extend the internal completion receipt with required original-start evidence or explicit null. Only successful original submission supplies it, beside the existing receipt installation after the validated running publication. Copy the minimum scalar identity/start fields into an internal snapshot; do not retain the caller-visible mutable RunJob as the evidence object. R3/R5 takeover explicitly supplies null. This is not a boolean origin flag or a new public API.

Bind evidence to run_id, job_id, run_dir, pid, pid_started_at and started_at. Compare timestamps as the same instants, without changing existing process-ownership comparators. At settlement, require matching original evidence and a terminal transition actually published by this instance. Mint a terminal observation only after that synchronous atomic publication succeeds, before asynchronous completion can consume the receipt. Include the observed finished_at. Do not mint from a pre-existing terminal record merely because a local receipt still exists; failed/deferred publication or mismatched original identity gives no observation.

A dispatcher-private per-run observation map bridges receipt deletion and later collect. Completion failure retains the same terminal observation without resetting finished_at or recomputing an endpoint. Submission rollback already removes the original receipt before any eligible terminal observation; no second eligibility Set/map is needed. Such a duplicate index would add rollback/drain ownership without stronger identity evidence than the copied receipt snapshot.

### 3. One collector, validation before withholding

All four existing direct/automatic/startup collection routes use one internal dispatcher handoff to the canonical collector. Pass the matching observation data, not an unbound boolean. The collector compares it with the freshly routed, fully validated run used for this attempt; missing or mismatched run/process/start/finish evidence withholds the number as null. Keep the existing single formula.

Preserve the current validation order: calculate the candidate interval from known timestamps and validate the candidate through the existing RunRecord schema before withholding an unwitnessed number. Thus a negative known interval still produces the existing controlled validation/ledger failure even without observation evidence; it is not clamped or hidden by null. After successful validation, changing only the nullable duration to null is schema-valid and needs no second full parse. Unknown timestamps remain null.

This adds no new disk authority or concurrency protocol: existing per-entry exclusion, full metadata validation, synchronous RunJob transitions, path/inode guards and immutable RunRecord publication remain intact. Observation matching does not make external concurrent file tampering safe or alter the existing single-user boundary.

### 4. Commit, retry and lifetime

Generation failures retain the observation for same-instance retries, including direct retries after automatic budget exhaustion; they must not change its endpoint. Drop the handoff when a committed result is successfully returned or a validated committed checkpoint is encountered, on completed-index migration, and after accepted work drains during instance disposal. Never clear it while an admitted collect still needs it. A projection failure after record commit may leave the entry until the next committed-checkpoint read; it cannot cause regeneration or change the committed value. Retention is proportional to this instance's still-active run entries, not a process-global history or notification cache.

The retry-retention promise applies while that active, uncommitted handoff exists. If failure notification finalizes the run into the completed index without a RunRecord, pruning ends the handoff; later manual generation has missing observations and yields null. Verify this through public collection alongside the active-capped numeric retry control, not by inspecting map size. A committed record still wins unchanged.

A registry reload or process death loses both original-start and terminal observations. Before RunRecord commit, a later instance generates null even if both timestamps exist. After commit, the valid same-identity record wins before all timing logic: return the same value/bytes/mtime and repair only the existing collected projection. Historical committed numbers are neither rewritten nor retroactively certified. No nullable timestamp is repurposed as a confidence marker.

### 5. Canonical semantic metadata and projections

Add canonical Zod descriptions for the relevant existing time fields, without changing validation or shape. Descriptions of nullable fields belong to the whole field, including the null case. The renderer reads the original property's description before falling back to its non-null branch, so nullable-wrapper metadata is not lost. This supports both placements rather than relying on an annotation-placement workaround.

Emit optional field-semantics notes only for annotated fields; preserve the existing five-column field table, enum values, example generation and unannotated projections. Do not append prose to enum constraint strings or reshape every generated document. JSON Schema annotations come from Zod; Markdown consumes that same metadata. Regenerate with schema:generate, never edit generated files. Exercise nullable annotation preservation and escaping through the existing generator self-test pattern; actual generated wording is verified with a throwaway projection check rather than permanent pins to current prose.

Update Minimal_Schemas through its established M2 revision channel (its current line 14 and the active Generated projection requirement explicitly permit/require alignment). Sync current Park_Resume_Design, instruction source/status and only the affected project-profile duration reference; render instruction projections. M2 normative formula/record/collection wording is updated and historical checked task lines remain unchanged, with a dated follow-up appended. Frozen historical archives and unrelated glossary drift stay untouched. The existing schema-drift policy still describes the same output classes; no policy/gate relaxation is needed.

## Evidence and risks

- Untrusted disk timestamps formerly produced 2.5: retain the seeded contract test as a null RED, while real original online execution still yields a nonnegative, exactly recomputable window through both automatic and direct collection.
- Extend existing R6, R3/R5 takeover and R8 controls to require null while preserving original timestamps, identity, outcomes, signals and notification assertions. Local cancellation retains a numeric observation window, including the observed grace/detection interval; lost/invalid evidence does not gain a number.
- Prove failed terminal publication creates no observation, completion/generation failures retain the original one, and mismatched start/process/finish snapshots cannot authorize a new number. Keep the existing unwitnessed negative-duration test unchanged.
- Use actual native child-process fixtures and a deterministic publication/completion barrier: crash after terminal publication but before RunRecord commit, then recover in another process to null; after a genuine original-instance numeric record commits, re-collect in another process with identical bytes/mtime. Registry replacement alone is not cross-process proof. Reuse existing child/native fixture patterns, with owned cleanup and no fabricated process identity or time proof.
- Preserve committed-record priority across failed collected projection and retry ledgers. No new file, global timing state, timer, signal path or persistence migration.
- Run canonical generation/self-tests, full default check, profile smoke, native duration scenario and actual Web restart gate. Check existing runtime/tool duration assumptions before implementation; do not narrow a gate to hide changed semantics.

## Migration and rollback

Clean producer cutover: all internal collector/receipt callers migrate together; no aliases, compatibility computation or alternate collector. New records obey the evidence rule, old valid committed records remain immutable. Revert the reviewed change as a unit if necessary; both null and numeric values remain valid under the unchanged schema shape. Engineering merge and this independent archive do not close #293/#318 or archive m2-run-chain.
