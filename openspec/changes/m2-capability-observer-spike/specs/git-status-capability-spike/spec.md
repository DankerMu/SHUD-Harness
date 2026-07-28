## ADDED Requirements

### Requirement: Spike remains isolated from production
The repository SHALL implement the Git status capability observer only under the
spike ownership boundary. The spike MUST NOT be imported, invoked, packaged, or
shipped by a production package; MUST NOT change StackLock schema/runtime behavior;
MUST NOT change production manifests, lockfiles, imports, generated schemas,
release assembly, existing workflows, canonical docs, or the four read-only
submodules; and MUST NOT close Issue #132 or restore PR #133 behavior.

#### Scenario: Spike executes without production integration
- **WHEN** the spike runner, native prototype, fixtures, validator, evidence, and isolated CI entry are added
- **THEN** the only changed paths relative to frozen base `2bf3ef8859278dd0817100c01775765612170648` are `spikes/git-status-capability/**`, `.github/workflows/git-status-capability-spike.yml`, and this OpenSpec change directory

#### Scenario: Accepted evidence is produced
- **WHEN** a valid complete run yields terminal decision `accepted`
- **THEN** the result is local architecture input only; its summary records #132 OPEN/blocked, #133 reverted, zero GitHub mutation, and the separate OpenSpec/ADR plus human gate without altering external state

#### Scenario: Rejected evidence is produced
- **WHEN** a valid complete run yields terminal decision `rejected`
- **THEN** its local summary references causal evidence and records the identical #132 OPEN/blocked, #133 reverted, and zero-GitHub-mutation facts; no external comment or fallback is added

### Requirement: Observer uses descriptor-bound authority while the harness protects the collection
The native observer MUST receive one already-open checkout directory descriptor,
validate and duplicate it, and read checkout content only relative to that
capability. After admission it MUST NOT reopen or identify the checkout through an
original path, `/proc/self/fd`, `/dev/fd`, `realpath`, repository discovery,
current-directory pathname recovery, or another ambient filesystem authority.

Before fixture output or transient creation, the launcher SHALL create a
descriptor/identity-bound collection-wide protection set containing the canonical
superproject, `SHUD`, `rSHUD`, `AutoSHUD`, `zero`, the currently admitted
disposable checkout, every frozen present nested checkout, every declared absent
nested path's held parent/basename, and every physical or symlink alias prepared
by the fixture. That set is available only to
launcher/tripwire/oracle code, not to the observer. Every invocation MUST have
zero transient create/delete/rename/chmod/timestamp/index-refresh/lock/object write
inside every protected member.

#### Scenario: Original path is replaced after admission
- **WHEN** the launcher opens the descriptor, freezes oracle and frame, then renames and replaces the original checkout pathname with a directory, symlink, or file
- **THEN** the observer reports the held checkout state or the catalog's stable rejection and never reads the replacement

#### Scenario: Invalid descriptor is supplied
- **WHEN** the designated descriptor is absent, closed, not a directory, not allowlisted, or unexpectedly aliased
- **THEN** the exact catalog rejection is emitted before checkout traversal and no clean/dirty answer is emitted

#### Scenario: Ambient descriptor pathname is present
- **WHEN** Linux exposes `/proc/self/fd` or macOS exposes `/dev/fd`
- **THEN** neither path is accessed and the identical descriptor-relative contract is enforced

#### Scenario: TMPDIR or output aliases any protected member
- **WHEN** TMPDIR, pre-created output, or another transient authority is the superproject, any published checkout, the admitted checkout, nested checkout, physical alias, or symlink alias
- **THEN** the launcher emits the catalog's protected-root rejection before the first creator call

#### Scenario: An exact invocation attempts a transient write
- **WHEN** a controlled public-OS-boundary fault attempts create-then-delete, chmod/utime, index refresh, lockfile, or object write
- **THEN** the active tripwire detects it, the row returns its exact expected rejection, and the full protection-set pre/post oracle remains decision evidence

### Requirement: Observer consumes one bounded generation-bound frame
The observer SHALL consume one versioned, length-prefixed, checksummed Git-state
frame from standard input. The frame MUST contain only bounded values and
repository-relative names and MUST bind the catalog version, exact row ID,
deterministic observation ID, checkout capability identity, Git-state generation
digest, index and split-index material, HEAD tree, effective local/worktree/include
status configuration, exclude/attribute state, and mandatory nested state. It
MUST NOT contain or require an absolute checkout or Git-directory pathname.

#### Scenario: Valid payload is frozen before observation
- **WHEN** the producer freezes expected outcome and frame before the observation boundary
- **THEN** observer and evidence bind the exact frame bytes, length, digest, checkout identity, row, observation ID, and generation digest

#### Scenario: Frame is structurally invalid
- **WHEN** the frame is truncated, oversized, surplus, checksum/version mismatched, has duplicate unique fields, or contains an absolute or escaping path
- **THEN** it rejects before checkout traversal with the exact non-disclosing catalog code and emits no partial clean/dirty answer

#### Scenario: Valid split index is present
- **WHEN** a catalog row supplies a split index and valid shared-index material in the frame
- **THEN** both inputs are generation-bound and the observer matches the pinned oracle without a Git-directory pathname

#### Scenario: Split-index backing is invalid
- **WHEN** catalog row `IDX-007` or `IDX-008` supplies missing or corrupt shared-index material
- **THEN** the exact expected rejection is emitted and the negative row passes rather than rejecting the technology

#### Scenario: Foreign checkout frame is replayed
- **WHEN** a valid frame is paired with another checkout descriptor
- **THEN** the observer rejects `REPLAY_FOREIGN_CHECKOUT` at descriptor/frame identity validation before traversal

#### Scenario: Stale or cross-row frame is replayed
- **WHEN** the frame generation is not the just-frozen scheduled generation or its row differs from the scheduled row
- **THEN** the launcher rejects `REPLAY_STALE_GENERATION` or `REPLAY_CROSS_ROW` before inheritance and the validator also rejects cross-slot reuse as harness-invalid

#### Scenario: Deterministic repeat is legitimate
- **WHEN** catalog row `DET-001` repeats byte-identical frame bytes with the same checkout object, row, observation ID, and generation
- **THEN** both sub-observations are allowed and must be byte-identical; no replay cache rejects the repeat

### Requirement: Low-level implementation performs no discovery, fallback, or helper execution
The prototype MUST use low-level in-memory gix index/status operations and
descriptor-relative filesystem operations. It MUST NOT call high-level repository
discovery/opening, canonicalize/reopen a worktree or Git directory, invoke Git or
vanilla libgit2, or execute hooks, fsmonitor, filters, diff drivers, credential
helpers, pagers, editors, shells, or network clients during observation.

Acceptance evidence SHALL include a transitive filesystem/process/network call
ledger for the exact binaries and enabled features actually built on both targets,
plus active runtime traces/tripwires for the exact matrix invocation. Every
reachable touching crate/call site MUST be classified and tied to an allowed
capability and control.

#### Scenario: External helpers are configured
- **WHEN** `HLP-001` through `HLP-017` configure executable helper and network sentinels
- **THEN** none executes or connects and each row produces its exact expected outcome, including the expected process-filter rejection

#### Scenario: Low-level API reaches ambient authority
- **WHEN** an active tripwire observes discovery, pathname reopen, `/proc/self/fd`, `/dev/fd`, unexpected root access, process spawn, or network access
- **THEN** that mandatory row fails and a valid complete experiment can only be terminal `rejected`

#### Scenario: Transitive call evidence is incomplete
- **WHEN** a reachable filesystem/process/network edge is missing, unclassified, or cannot be verified against the exact build
- **THEN** run status is `invalid`, CI is red, and no terminal decision exists

#### Scenario: Capability route cannot represent a semantic row
- **WHEN** low-level gix cannot compute a clean/dirty semantic row from descriptor and frame
- **THEN** the row records an unexpected rejection or `PLATFORM_UNSUPPORTED`, row verdict is `fail`, and a valid complete experiment is terminal `rejected` without fallback

### Requirement: One exact mandatory catalog runs on macOS and Linux
Catalog version 1 SHALL contain exactly the 174 IDs and per-platform expected
outcomes frozen in `design.md`. The fixture manifest MUST exactly equal that ID set
and outcomes; it MUST contain no extra, missing, duplicate, optional, skipped,
platform-qualified, conditional-only, or implementer-selected row. Each ID SHALL
execute exactly once on macOS and exactly once on Linux.

No semantic row may become decision-bearing or be recorded as pass before the
canonical catalog/schema, deterministic validator, row-specific pinned-Git oracle,
and active path/process/network/write tripwires are implemented and bound to the
same source-input digest.

The manifest SHALL also contain the exact `F132-01..25` evidence-floor crosswalk frozen in design: each floor ID maps to exactly one distinct catalog row, exact oracle, task-2 fixture owner, and task-4 native owner. A missing floor item, a row carrying multiple floor IDs, duplicate mapping, owner drift, or a merged aggregate in place of an independent row is harness-invalid.

#### Scenario: Complete Git status semantics are exercised
- **WHEN** all catalog rows run
- **THEN** the matrix covers clean/tracked/staged/untracked, assume-unchanged, skip-worktree, conflict stages, racy timestamps, index v2/v4/split, ignore/attributes including `.git/info/attributes`, effective local/worktree/include config, `core.excludesFile`, `core.attributesFile`, `core.autocrlf`, `core.eol`, `core.fileMode`, `core.ignoreCase`, `core.trustctime`, `core.checkStat`, `core.ignoreStat`, Git boolean aliases, normal and `.git`-indirection layouts, linked worktrees, and initialized/dirty/deinitialized/absent direct/recursive nested states exactly as frozen

#### Scenario: Security and lifecycle rows are exercised
- **WHEN** all catalog rows run
- **THEN** replay, helper nonexecution, descriptor/path attacks, collection-wide protection, exact/bound-plus-one limits, cleanup, timeout, signal, parallel isolation, and determinism rows execute with their exact expected outcomes on both platforms

#### Scenario: The #132 evidence floor executes without merged coverage
- **WHEN** the crosswalk is validated and the matrix runs
- **THEN** linked/nested split-index clean and dirty; three nested drift transitions; LF/U+2028/U+2029 gitlink recursion; stage-1/2/3 conflict, unknown-stage and malformed-index failures; six main/linked/nested worktree/included-filter cases; three audit→inject cases; and nested fsmonitor each have one distinct row, oracle, fixture owner, and native owner

#### Scenario: One platform cannot execute a row
- **WHEN** a platform reports `rejected(PLATFORM_UNSUPPORTED)` for a row whose frozen expectation differs
- **THEN** the row verdict is `fail` and a valid complete experiment is terminal `rejected`; it is never skipped or borrowed from the other platform

#### Scenario: A semantic row runs before prerequisites are ready
- **WHEN** catalog, validator, its oracle, or active tripwire identity is absent or bound to another source digest
- **THEN** the evidence is harness-invalid and cannot record a decision-bearing pass

### Requirement: Outcome, verdict, validity, and decision are distinct
The evidence schema SHALL model exactly these layers:
`observer_outcome = clean | dirty | rejected(code)`, per-platform
`expected_outcome`, `row_verdict = pass | fail`,
`run_status = valid_complete | invalid`, and optional
`terminal_decision = accepted | rejected`. Terminal decision MUST exist only for
`valid_complete` evidence.

#### Scenario: Expected negative row rejects precisely
- **WHEN** a guard, replay, helper, bound-plus-one, timeout, signal, or cleanup row emits its exact expected rejection code and all row assertions pass
- **THEN** row verdict is `pass`; this negative test does not by itself make the technology rejected

#### Scenario: Exact bound is reached
- **WHEN** an exact-bound `LIM-*` fixture reaches its declared inclusive limit
- **THEN** its clean outcome is allowed and the row passes

#### Scenario: Bound is exceeded by one
- **WHEN** the paired fixture exceeds that limit by the smallest declared unit
- **THEN** no partial clean/dirty answer is emitted and only the paired exact limit code yields row pass

#### Scenario: Semantic capability rejects unexpectedly
- **WHEN** a semantic row expected clean/dirty instead returns any rejection or unsupported result
- **THEN** row verdict is `fail` and a valid complete experiment is terminal `rejected`

#### Scenario: Evidence contract is broken
- **WHEN** evidence is missing, duplicate, corrupt, stale, oversized, schema-invalid, identity-mismatched, or lacks an active oracle/tripwire/gate record
- **THEN** run status is `invalid`, terminal decision is absent, harness-health and expectation commands fail, and CI is red

#### Scenario: All platform rows pass
- **WHEN** all 348 platform-row slots pass and every supply/repository/governance gate is valid
- **THEN** run status is `valid_complete` and terminal decision is `accepted`

#### Scenario: At least one row fails in an otherwise valid experiment
- **WHEN** all harness evidence/gates are complete but one or more row verdicts fail
- **THEN** run status is `valid_complete`, terminal decision is `rejected`, and harness-health succeeds while `expect accepted` fails

### Requirement: Observation is read-only, bounded, and fully settled
The observer MUST enforce the inclusive finite bounds frozen in the catalog for
frame/index bytes, index entries, path bytes/depth, nested repositories, traversal,
hashed bytes, wall/CPU time, threads, memory, and output. It MUST close or reap
every acquired descriptor and process on success, rejection, timeout, signal, and
cleanup failure. It MUST preserve the primary observation error and record cleanup
errors separately.

#### Scenario: Any row completes
- **WHEN** a row reaches a terminal observer outcome
- **THEN** the entire protection-set pre/post content and metadata inventories are equal, the event ledger has zero unfaulted write, and descriptor/process baselines are restored

#### Scenario: Timeout or signal interrupts observation
- **WHEN** `LIF-003`, `LIF-004`, or `LIF-005` runs
- **THEN** the launcher bounds termination, reaps the process, closes inherited descriptors, preserves all protected members, and emits the exact expected code

#### Scenario: Primary and cleanup failures coincide
- **WHEN** `LIF-006` triggers frame-version failure plus cleanup failure
- **THEN** `FRAME_VERSION_UNSUPPORTED` remains the observer outcome and first cause while the cleanup code appears only in the ordered secondary array

#### Scenario: Cleanup alone fails
- **WHEN** successful observation is followed by the `LIF-007` cleanup fault
- **THEN** no clean/dirty result survives and observer outcome is `rejected(CLEANUP_FAILED)`

### Requirement: Experimental supply chain is complete and reproducible
The spike SHALL freeze Rust `1.88.0`, Git oracle `2.49.0`, one `Cargo.lock`, every
direct crate version/feature, and a target dependency-graph catalog before native
semantic implementation. Builds SHALL use locked/frozen resolution and SHALL have
no floating Git, branch, wildcard, or path source.

Both targets MUST use identical source, lockfile, and direct features. Complete
graphs may differ only by target-predicate edges predeclared from the same lockfile;
each platform's actual complete graph digest MUST exactly match its frozen catalog
digest. Each exact build MUST produce a complete direct-feature inventory,
dependency graph, SBOM, and package/license-file inventory with digests.

#### Scenario: Both platforms build the frozen experiment
- **WHEN** macOS and Linux build the native helper
- **THEN** evidence binds identical source/lock/direct features plus the exact predeclared target graph, `rustc -Vv`, Cargo version, and target triple for each platform

#### Scenario: Dependency identity diverges unexpectedly
- **WHEN** a lockfile/direct feature/source differs or an actual target graph contains an unlisted difference
- **THEN** the harness is `invalid`, CI is red, and no terminal decision exists

#### Scenario: SBOM or license inventory is incomplete
- **WHEN** a built dependency, feature, source, SBOM entry, or license file cannot be accounted for
- **THEN** the harness is `invalid` and cannot be accepted

#### Scenario: License contents are reviewed
- **WHEN** the complete inventory contains any license set
- **THEN** contents are reported as advisory architecture input because no Rust license allowlist exists; the spike MUST NOT claim a fabricated license-policy pass

### Requirement: Source input identity uses one exact framed digest
The harness SHALL compute `source_input_digest_v1` as SHA-256 over the exact
binary frame defined in design D8. Its fixed domain prefix SHALL be the ASCII bytes
`SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0`, followed by
unsigned big-endian `u32` entry count and, for each entry sorted by raw
repository-relative UTF-8 path bytes, unsigned big-endian `u32` path length, raw
path bytes, `u32` Git mode parsed as octal, `u64` content length, and raw Git blob
bytes.

The strict `contracts/source-input-v1.paths` manifest SHALL list itself and exactly
all Git-tracked regular files under the spike, the isolated spike workflow, and
this change's `.openspec.yaml`, proposal, design, tasks, and specs. Only Git modes
`100644` and `100755` are allowed. Final evidence output is excluded. The source
commit SHALL be recorded beside the digest but MUST NOT be hashed into it.

Both `PLATFORM-SOURCE-INPUT` and `GATE-SOURCE-INPUT` SHALL run the independently
implemented `source-input-primary-v1` and `source-input-witness-v1` against the
same live manifest and `SOURCE_SHA`.
They MUST share no framing/enumeration implementation, and their digest, entry
count, manifest digest, and admitted path/mode set MUST match. No literal digest
of the live manifest may be committed or used as an oracle. The only committed
literal SHALL be `contracts/goldens/source-input-v1.synthetic.sha256` for the
fixed synthetic frame vector.

Task 5.1 SHALL be the sole producer of
`<external-evidence-root>/source-input-record.json` before either platform run;
task 5.4 SHALL publish those
unchanged bytes only at
`evidence/final/<source-input-digest>/source-input-record.json`. That persisted
path is excluded from the source preimage. The record SHALL bind `SOURCE_SHA`,
the live digest/manifest, both encoder identities/results, and argv/version/exit
receipt, but SHALL contain no self-hash.
All other evidence SHALL bind only the source-record SHA-256, not repeat the live
digest field. D9's `GATE-SOURCE-INPUT` SHALL rerun both encoders with `--no-write`
and verify the immutable record.

#### Scenario: Source digest is reproduced independently
- **WHEN** the primary and witness runtime encoders consume the same live manifest and `SOURCE_SHA`
- **THEN** both runtime encoders compute the same live SHA-256 without consulting a live literal, while each separately matches the committed literal only for the fixed synthetic frame

#### Scenario: Live digest recording fails closed
- **WHEN** either encoder fails, their outputs or admitted sets differ, a live digest literal exists in committed inputs, the create-new external record already exists, or its bytes drift before publication
- **THEN** the run is `invalid`, CI is red, and no candidate or terminal evidence is published

#### Scenario: A decision input changes
- **WHEN** one content byte, UTF-8 path byte, Git mode, manifest entry, spike input, workflow, proposal, design, task, or spec changes
- **THEN** `source_input_digest_v1` changes, every older bundle is invalid, and both platform matrices, supply capture, and all D9 gates rerun

#### Scenario: Source input enumeration is unsafe or drifts
- **WHEN** a path is duplicate, non-UTF-8, non-canonical, untracked, a symlink/non-regular file, absent/extra relative to the closed candidate rules, or differs from `SOURCE_SHA`
- **THEN** hashing fails harness-invalid before a digest or terminal result is accepted

#### Scenario: Only final evidence or evidence commit changes
- **WHEN** only `evidence/final/**` or the evidence-only descendant commit changes while every enumerated blob/mode is identical
- **THEN** the digest remains identical because final output and the separately recorded commit ID are not in the preimage

### Requirement: Persistent evidence and post-matrix repository gates control the terminal result
Each platform SHALL emit strict bounded raw evidence for every catalog row and all
identities, commands, counters, call traces, protection oracles, supply artifacts,
and cleanup results. The final PR MUST persist the bounded raw bundle or immutable
content-addressed references under this change; expiring CI artifacts alone are
insufficient.

Per-run raw output MUST be created under a harness-owned external evidence root
outside the protection set. Publication into this change directory MAY occur only
after all observer processes are reaped, every collection-wide zero-write oracle
has closed, D9 gates pass, and D10's candidate expectation succeeds; it MUST NOT
be an observer or launcher write authority.

The validator SHALL compute the exact `raw_evidence_digest` and normalized
`decision_projection_digest` defined in `design.md`. It SHALL include every
decision-bearing identity/outcome/gate and exclude only the enumerated volatile
timestamps, host/job/path/process/descriptor assignments, ordering, diagnostics,
and below-bound measured counters. Secrets and absolute fixture paths MUST be
absent from raw and derived evidence.

Tasks 5.1/5.2 SHALL run design's fixed `PLATFORM-SOURCE-INPUT`, `PLATFORM-NATIVE`, and `PLATFORM-MATRIX`
commands using Rust `1.88.0` and Git `2.49.0`. After both matrices and supply
capture, task 5.3 SHALL run every and only fixed pre-decision command in design D9
using Bun `1.2.19`, OpenSpec `1.3.1`, Git `2.49.0`, and frozen base/merge-base
`2bf3ef8859278dd0817100c01775765612170648`. It SHALL record exact argv/version,
exit code, bounded summary/digest, and source-input-record SHA-256 for source framing,
full `check`,
`schema:check`, PERF-API-001, docs self-test/links, strict OpenSpec validation,
4/4 OpenSpec artifact status, base-to-HEAD `git diff --check`, tracked allowed-path scope, untracked inventory,
production manifest/import/schema/release isolation, and exact clean pins for
SHUD/rSHUD/AutoSHUD/zero. It SHALL also run the fixed GET-only governance gate:
#132 is OPEN with blocked recovery, PR #133 merge
`7d74a56eff27e34099961bdf14a40678c88d2603` remains reverted from `main` by
`2bf3ef8859278dd0817100c01775765612170648`, and GitHub mutation count is zero.
D9 MUST NOT derive/read a candidate decision or run
health/expect/publication commands.

#### Scenario: Volatile raw data changes without a decision change
- **WHEN** timestamps, temporary roots, map order, job IDs, numeric FDs, or below-bound counters vary while included identities/outcomes/classes are identical
- **THEN** raw digest changes, decision projection digest remains identical, and golden tests prove the normalization

#### Scenario: Decision-bearing data changes
- **WHEN** source/input, catalog, expected/observed outcome, rejection code, boundary class, dependency/call/SBOM/license digest, or gate verdict changes
- **THEN** decision projection digest changes

#### Scenario: Source or input digest changes after a platform run
- **WHEN** any covered source/input byte changes before final validation
- **THEN** old bundles become invalid and both platform matrices, supply capture, and repository gate must rerun; selective reuse is forbidden

#### Scenario: Repository or reproducibility gate fails
- **WHEN** any fixed gate command fails or its command/source record is missing or mismatched
- **THEN** run status is `invalid`, CI is red, and no terminal technology decision is emitted

#### Scenario: Governance state is unsafe or cannot be verified read-only
- **WHEN** #132 is not OPEN/blocked, #133 is no longer reverted from `main`, any GitHub mutation-capable request occurs, or the GET-only receipt is absent/mismatched
- **THEN** run status is `invalid`, CI is red, and neither accepted nor rejected is published

#### Scenario: Candidate is derived and asserted
- **WHEN** both bundles and D9 pass
- **THEN** task 5.4 derives `candidate-decision.json` in external same-filesystem staging, runs exactly the matching literal expectation, repeats the GET-only governance assertion, then invokes task 1.3's already source-digested finalizer without changing source

#### Scenario: Candidate assertion or publication fails
- **WHEN** candidate health, matching expectation, governance recheck, source-record/digest recheck, cleanup, atomic no-replace rename, or destination-absence validation fails
- **THEN** run status is `invalid`, CI is red, the final destination remains absent, and no staged candidate is a published terminal result

#### Scenario: Candidate is atomically published
- **WHEN** candidate health, matching expectation, governance recheck, and all source/digest records match
- **THEN** task 1.3's fixed finalizer performs one same-filesystem atomic no-replace directory rename; destination races/no-clobber, cross-device, overwrite, partial rename, cleanup failure, copy, merge, and file-by-file fallback fail with an absent final destination

#### Scenario: Raw evidence would only live in CI
- **WHEN** no bounded committed bundle or durable immutable content-addressed reference with retrieval proof exists
- **THEN** the harness is invalid and terminal acceptance is impossible

### Requirement: Terminal result controls only follow-up planning
The spike decision SHALL NOT authorize production adoption. Both `accepted` and
`rejected` summaries MUST persist the identical `governance-handoff` facts: Issue
#132 is OPEN with `recovery_state=blocked`, PR #133's merge remains reverted from
`main`, this change made zero GitHub mutations/comments, and no production
integration occurred. The summaries may contain local durable references but MUST
NOT publish a comment or mutate/close/merge an issue or PR.

Any production integration, close, merge, comment, retry promotion, or release
MUST use a separate reviewed OpenSpec change and ADR covering process/FFI
boundaries, packaging, dependency policy, migration, release/runtime failures,
and StackLock integration, followed by an explicit human approval gate.

#### Scenario: Either valid terminal value is handed off
- **WHEN** reviewers confirm a persisted valid `accepted` or `rejected` bundle
- **THEN** the same read-only governance record and pre-publication recheck are present, #132 remains OPEN/blocked, #133 remains reverted, GitHub mutation count is zero, and only a future explicit human gate may authorize an external or production action

#### Scenario: Accepted result is handed off
- **WHEN** reviewers confirm a persisted valid `accepted` bundle
- **THEN** it is local architecture evidence only; a separate OpenSpec/ADR plus human approval must decide every production surface

#### Scenario: Rejected result is handed off
- **WHEN** reviewers confirm a persisted valid `rejected` bundle
- **THEN** its local summary references causal evidence without commenting on #132, the native approach is not integrated, and another direction requires a new reviewed proposal and human approval

#### Scenario: Harness run is invalid
- **WHEN** run status is `invalid`
- **THEN** no accepted/rejected summary is published as a technology result; the experiment is repaired and rerun without changing canonical docs or the #132 blocker report to manufacture closure
