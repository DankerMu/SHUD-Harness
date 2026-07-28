# M2 Git Status Capability Observer Spike — Design

## Context

Issue #132 must record the actual dirty state of a repository while preserving the
existing path-safety contract. The reverted implementation could freeze Git
metadata and hold an open descriptor for the checkout, but the Git CLI still
needed pathname access to both authorities. Linux happened to make an inherited
directory descriptor traversable through `/proc/self/fd`; macOS did not provide
equivalent traversal through `/dev/fd`. Converting either authority back to an
ambient pathname would reintroduce the path-replacement race that the contract is
intended to prevent.

This change is therefore a feasibility experiment, not a production feature. It
tests whether low-level Rust `gix` plumbing can compare a descriptor-bound
checkout with immutable Git-state bytes without reopening either authority by an
ambient pathname. The result may be `accepted` or `rejected`; both are complete
outcomes when backed by the mandatory evidence matrix.

The current repository is a Bun/TypeScript workspace and has no committed Rust
toolchain policy. The spike must remain outside production packages and must not
change StackLock runtime behavior, schemas, APIs, generated contracts, persistent
records, or the four read-only submodules. Issue #132 remains open and blocked
until a separately reviewed production-integration change exists.

Primary technical references used to bound the hypothesis:

- `gix` exposes an in-memory index override and lower-level index/worktree status
  plumbing: <https://docs.rs/gix/latest/gix/status/index.html> and
  <https://docs.rs/gix-status/latest/gix_status/>.
- `cap-std` can construct a directory capability from an existing directory file
  descriptor: <https://docs.rs/cap-std/latest/cap_std/fs/struct.Dir.html>.
- vanilla libgit2 repository construction and workdir assignment accept path
  strings, so that route does not remove the two-authority problem:
  <https://libgit2.org/docs/reference/main/repository/git_repository_open.html>
  and
  <https://libgit2.org/docs/reference/main/repository/git_repository_set_workdir.html>.

### Stakeholders and constraints

- The PI owns the accept/reject decision policy and has approved a bounded,
  non-production Rust/gix spike.
- macOS and Linux are both mandatory. A Linux-only result is rejection.
- The safety invariant is zero transient write to the protected checkout and zero
  ambient-path reopen after capability admission.
- No compatibility fallback may invoke Git, libgit2, or any helper through a
  pathname when the capability route fails.
- The spike may create and mutate its own disposable fixtures and evidence output
  directory; it may not write within an admitted protected checkout during an
  observation.

## Goals / Non-Goals

**Goals:**

- Build an isolated, pinned Rust experiment that consumes one inherited checkout
  directory capability and one bounded immutable Git-state payload.
- Determine, on both macOS and Linux, whether the experiment can match the
  canonical Git dirty/clean oracle for every mandatory fixture without ambient
  pathname reopening, external helper execution, or protected-root mutation.
- Bind machine-readable evidence to source, fixture, toolchain, dependency,
  platform, and command identities, and derive exactly one deterministic
  `accepted` or `rejected` decision.
- Leave enough reproducible evidence to prevent a failed approach from being
  silently retried or a successful approach from being promoted without a new
  architecture and implementation review.

**Non-Goals:**

- Integrating Rust, `gix`, or a native binary into StackLock, the backend, the
  frontend, the Bun workspace, release artifacts, or production CI packaging.
- Reinstating any code from merged-and-reverted PR #133 or closing Issue #132.
- Changing the meaning of `repos.*.dirty`, weakening no-follow/path-replacement
  protections, or adding a Linux-only or pathname fallback.
- Selecting the final production FFI/process boundary, deployment mechanism, or
  long-term Rust dependency policy.
- Claiming parity outside the committed mandatory corpus or supporting a row by
  marking it skipped.

## Planning contract and grill gate

The Stage 1 decision tree is closed for this spike:

| Branch | Decision | Source |
|---|---|---|
| Issue #132 disposition | Keep Issue #132 open and blocked; PR #133 remains reverted from `main`. | User |
| Safety contract | Preserve descriptor-bound authority, zero transient protected-root writes, and no ambient-path fallback. | User |
| Platform support | macOS and Linux are both mandatory; Linux-only is rejected. | User |
| Technology scope | Test isolated low-level Rust/gix plumbing; reject vanilla path-based libgit2 as the proposed answer. | User plus API fact-check |
| Promotion gate | Accept only if every mandatory row passes on both platforms; otherwise reject with evidence and do not integrate. | User |
| Delivery boundary | Deliver only spike code, fixtures, evidence, and a decision; production integration requires a later reviewed change. | User |

There are no open decision branches for implementing the spike. Whether the
hypothesis is accepted is an experimental result, not an unresolved design
choice.

## Decisions

### D1. Isolate the spike from all production packages

The experiment lives under one spike-only ownership boundary with its own Rust
manifest, lockfile, toolchain pin, fixtures, runner, evidence schema, and CI entry.
It is not a Bun workspace member and no production package imports, invokes, or
ships it. Existing TypeScript checks continue unchanged and must remain green.

Alternative considered: add a native helper directly to the StackLock collector.
Rejected because dependency adoption, protocol design, packaging, and runtime
behavior would become coupled to a hypothesis that may fail.

### D2. Use an explicit two-authority protocol

The experiment has exactly two input authorities:

1. A checkout directory already opened by the fixture launcher with directory,
   no-follow, and close-on-exec policy made explicit. The launcher deliberately
   passes only the designated descriptor to the native helper. The helper first
   duplicates and validates the descriptor as a directory, records its stable
   identity, and makes it the process working directory with `fchdir` only for the
   duration of observation. Relative `.` access is permitted; `/proc/self/fd`,
   `/dev/fd`, the original checkout pathname, `realpath`, current-directory
   recovery through a pathname, or any other ambient namespace lookup is not.
2. A versioned, length-prefixed, checksummed, immutable Git-state payload supplied
   on standard input. It contains the bounded state needed by the attempted
   algorithm—at minimum parsed index inputs (including split-index material when
   present), the HEAD tree baseline, relevant effective Git status configuration,
   repository/exclude metadata, and any bounded nested-repository state required
   by a selected mandatory fixture. It contains repository-relative names and
   object identities, never an absolute or fixture-root pathname.

The frame header binds `catalog_version`, the exact `row_id`, a deterministic
`observation_id`, the descriptor-derived checkout capability identity, and a
`git_state_generation_digest` over every frozen HEAD/index/config/exclude/
attribute/nested input. The body digest and header are covered by the frame
checksum. These bindings have three independently enforced replay boundaries:

- the observer compares the frame's capability identity with `fstat()` of its
  duplicated descriptor and rejects a foreign checkout as
  `REPLAY_FOREIGN_CHECKOUT` before traversal;
- the launcher compares row, observation, generation, and exact frame digest with
  the just-frozen fixture schedule and rejects a stale generation as
  `REPLAY_STALE_GENERATION` or a cross-row frame as `REPLAY_CROSS_ROW` before
  inheritance;
- the evidence validator rejects reused observation/generation identities across
  different platform/row slots, or a payload digest not owned by that slot, as an
  invalid harness bundle with no terminal decision.

A byte-identical repeat for the same descriptor object, row, observation ID, and
generation is deliberately legal and is required by `DET-001`; the repeat is two
sub-observations inside one row record, not a duplicate catalog row. No replay
cache or nonce may turn that deterministic repeat into a failure. A different
checkout, generation, or row is never a legal repeat.

The payload is a spike protocol, not a production schema. Its fixture producer is
part of the experiment and must prove that the bytes used by the helper were
frozen before the adversarial path-replacement point. The evidence records both
payload length and digest. Payload truncation, surplus frames, checksum mismatch,
unsupported version, duplicate keys, invalid relative paths, or limit violation
must reject before checkout traversal and must not produce a dirty result.

The observer still receives exactly the current checkout descriptor and this one
frame. Launcher scheduling data, the replay ledger, the protected collection set,
and the fixture path namespace are harness authorities used only before/after the
invocation; none is passed to, discoverable by, or readable as a third ambient
authority by the observer.

Alternative considered: pass a second inherited Git-directory descriptor. The
prior failure already demonstrated that one process working directory cannot make
both descriptor roots consumable by path-oriented Git APIs on macOS. Alternative
considered: serialize a temporary Git directory and reopen it by pathname. Rejected
because that converts authority back to ambient namespace state.

### D3. Test low-level gix plumbing, not high-level repository discovery

The implementation starts from `gix-status`, `gix-index`, and only the additional
low-level crates needed to build in-memory comparisons. It may use `cap-std` to
reopen the inherited checkout descriptor and perform descriptor-relative reads.
It must inject the frozen index/HEAD/config state explicitly and must not call
high-level `gix::discover`, `gix::open`, or any API that canonicalizes/reopens a Git
directory or worktree by ambient path.

The prototype must keep a dependency/API ledger identifying each filesystem- or
process-touching call in the transitive execution path used by the experiment.
Tests must include active tripwires for ambient pathname access and subprocess
execution; source inspection alone is not acceptance evidence.

Alternative considered: vanilla libgit2. Its official repository open and
workdir-setting interfaces are path based, so it does not by itself solve the
capability boundary. Alternative considered: high-level `gix::Repository::status`.
Its implementation resolves repository and workdir paths, so it is prohibited in
this change; considering it would require a new reviewed proposal rather than an
implementation-time amendment.

### D4. Separate oracle generation from the capability observation

Each fixture has a setup phase in a disposable test root. During setup, pinned Git
produces the expected semantic result (or the independent negative oracle freezes
an exact rejection code) and the fixture producer freezes the Git-state payload.
Observation begins only after the expected result and payload
digest are fixed, the checkout descriptor is held, and any declared adversarial
mutation (such as renaming and replacing the original pathname) has occurred.

The observer receives neither the oracle command nor the fixture pathname. Oracle
generation may use Git before the observation boundary; the observer process may
not execute Git or any other external helper. The decision validator compares
normalized observer output with the precommitted expected row.

Alternative considered: invoke Git and the native observer in the same process
window. Rejected because a passing result could depend on a path or state that was
not actually frozen at the capability boundary.

### D5. Use four state layers and make only technical failure `rejected`

The schema does not overload one word for a negative test, a broken harness, and
the technology decision. It has four explicit layers:

1. `observer_outcome = clean | dirty | rejected(<stable_code>)`. The field is the
   normalized outcome of the observer boundary; launcher/tripwire rejections that
   intentionally occur before process entry use the same closed rejection
   taxonomy and record their producing boundary.
2. Every frozen catalog row declares one `expected_outcome` for macOS and one for
   Linux. `row_verdict = pass | fail` is exact equality of observed and expected
   outcome plus the row's required oracle and active-tripwire assertions.
3. `run_status = valid_complete | invalid`. `valid_complete` requires both
   platform bundles, all 174 row records exactly once, schema/identity/digest
   integrity, active controls, complete supply evidence, and a passing
   repository regression/isolation/reproducibility gate. Missing, duplicate,
   corrupt, stale, oversized, or contract-invalid evidence is `invalid`; it is not
   evidence about gix.
4. `terminal_decision = accepted | rejected` exists only when `run_status` is
   `valid_complete`. It is `accepted` only if all 348 platform-row verdicts pass;
   it is `rejected` if at least one row verdict fails. An invalid run has no
   terminal decision field and exits the harness-health command nonzero.

This makes expected negative fixtures safe: an exact-limit row is allowed and
passes with its declared clean/dirty result; the corresponding bound-plus-one,
guard, timeout, signal, or replay row passes only when it returns the exact
expected rejection code. A semantic capability row that unexpectedly returns a
rejection or `PLATFORM_UNSUPPORTED` is a row failure and yields a valid technical
`rejected` decision. A platform that cannot exercise a row must still emit that
row as `rejected(PLATFORM_UNSUPPORTED)` and therefore fail it; absence or skip is
instead harness-invalid.

Golden state-machine scenarios freeze these distinctions: all-pass accepted;
one unexpected semantic rejection rejected; an exact expected guard rejection
accepted when all other rows pass; exact-bound pass; bound-plus-one exact-code
pass; wrong rejection code rejected; platform unsupported rejected; missing,
duplicate, corrupt, oversized, stale-source, and failed repository-gate bundles
invalid with no terminal decision. The counter/timestamp variation scenarios in
D8 additionally prove digest stability.

The harness-health command exits zero for a schema-valid `valid_complete` run
whether accepted or rejected. A distinct expectation command fails unless the
decision equals the requested value. Invalid runs make both commands fail, so a
truthful experimental falsification cannot be confused with broken evidence.

Alternative considered: map missing evidence to technology rejection. Rejected
because a broken experiment cannot falsify the capability hypothesis.

### D6. Pin and inventory the experimental supply chain

The contract PR freezes Rust `1.88.0`, the Cargo version bundled with that
toolchain, Git oracle `2.49.0`, every direct crate version and feature flag, and
the complete `Cargo.lock` before native semantic work starts. Low-level
`gix-status`, `gix-index`, and capability-filesystem crates are permitted;
high-level gix discovery/open and vanilla libgit2 path APIs remain prohibited.
CI installs only those pins and uses `--locked --frozen` after a separately
identified acquisition step. Git/branch/path/wildcard/floating dependency sources
are forbidden.

One lockfile, direct dependency set, feature set, and source digest is shared by
macOS and Linux. `dependency-graph-catalog.json` freezes the only permitted
target-specific graph differences, each attributable solely to a target predicate
already present in that same lockfile. The macOS and Linux jobs each record and
match their predeclared complete graph digest; a second lockfile, direct-feature
difference, newly activated predicate, or any unlisted graph edge makes the run
`invalid` with no terminal decision.

Supply evidence is generated from the binary actually built for each target and
contains: `rustc -Vv`, Cargo version, target triple, OS/architecture, lockfile and
direct-feature digests, complete resolved package/feature/source graph, direct
features, an SPDX or CycloneDX SBOM, and a package-to-license-file inventory with
digests. Completeness and graph/catalog identity are harness-validity gates. This
repository has no existing Rust license allowlist, so license contents are
advisory architecture input; the spike must not invent a “license policy pass.”
Any production dependency policy or adoption decision belongs to the later
reviewed production change.

The filesystem/process call ledger is transitive, not a handwritten list of
direct calls. For the exact binaries and features actually built on both targets,
it records each reachable filesystem/process/network-touching crate, source file,
symbol or documented call site, allowed capability, and the active tripwire that
observes it. Static dependency/call analysis and the runtime trace of the exact
matrix binary are both evidence; an unclassified transitive call or unverifiable
edge makes the harness invalid and prevents acceptance.

Alternative considered: use the latest stable toolchain and crate releases.
Rejected because the result would not be reproducible or attributable.

### D7. Bound resources, environment, side effects, and cleanup

The native helper receives a minimal allowlisted environment and no inherited
network credentials, Git configuration overrides, hooks path, pager, editor,
shell, tracing, or helper configuration. Network access is disabled during the
observation step. Descriptor inheritance is allowlisted and audited before and
after every run.

The fixture manifest sets finite maximums for payload bytes, index entries,
relative-path bytes/depth, nested repositories, files/directories visited, bytes
hashed, wall time, CPU/thread count, memory, stdout/stderr, and evidence size. The
helper stops at the first exceeded observer bound with a stable rejection code;
the evidence emitter instead makes an oversized bundle harness-invalid. On success,
error, timeout, signal, and malformed input, descriptors and child processes must
be closed/reaped and the entire protection set must have identical pre/post
content and metadata oracles.

No hook, clean/smudge filter, fsmonitor, credential helper, pager, editor, shell,
or user-configured command may execute. Unsupported config that would require an
external helper is a deterministic rejection unless the canonical Git dirty
answer can be obtained without invoking it and parity is proven by the fixture.

Protection is collection-wide, not limited to the one descriptor admitted for a
row. Before any fixture output/TMPDIR creation or observer launch, the harness
constructs a descriptor/identity-bound `protection_set` containing the canonical
superproject, all four published checkouts (`SHUD`, `rSHUD`, `AutoSHUD`, `zero`),
the currently admitted disposable checkout, every present initialized or
deinitialized nested checkout named by the frozen fixture, each declared absent
nested path's held parent plus basename, and every physical or symlink alias
prepared by the adversarial fixture. Identity-equivalent
aliases collapse to one protected object but remain separate monitored ingress
names.

The launcher rejects TMPDIR, output, pre-creation, or sandbox paths that are in,
under, or alias any protected member before the first creator call. For every one
of the 174 rows, independent pre/post content+metadata inventories and an active
event/syscall tripwire cover the entire protection set, including create-then-
delete, chmod, timestamp, index refresh, lockfile, and object-write attempts. The
required result is collection-wide zero transient protected-root mutation. An
exact-invocation global filesystem ledger proving that the observer writes only
to its bounded evidence pipe/output authority may be added as stronger evidence,
but it cannot replace the set-wide pre/post oracle.

The protection set exists only in launcher/tripwire memory and evidence. The
observer still sees only its current checkout descriptor and payload; it cannot
query the set, fixture root, original names, aliases, or another ambient read
authority.

### D8. Bind evidence before deriving a decision

Each platform produces canonical JSON containing:

- schema version and `valid_complete|invalid` platform run status;
- the frozen source-bearing commit and digests of every spike-owned input;
- toolchain, target, complete dependency graph, direct features, transitive call
  ledger, license inventory, and SBOM identities;
- one result for every mandatory fixture row, including expected/observed state,
  timing, resource counters, capability/path/process/write tripwires, and stable
  error identity;
- descriptor inventory and collection-wide protection-set pre/post/event digests;
- raw-command manifest with secrets and absolute fixture paths excluded.

A deterministic validator accepts platform evidence only when all 174 catalog
rows are present exactly once, row IDs and expected outcomes exactly match the
manifest, all prerequisite oracle/tripwire identities are ready, bounds are
respected, and macOS/Linux bind to one experiment. It then consumes the supply and
repository-gate records before it may emit a decision JSON and Markdown summary.

The final implementation PR MUST persist a bounded reviewable bundle at
`openspec/changes/m2-capability-observer-spike/evidence/final/<source-input-digest>/`.
Each platform raw subtree is at most 8 MiB and the complete directory, including
repository gates and derived reports, is at most 20 MiB. CI artifact retention is
not evidence persistence. If repository policy prevents committing the bounded
raw bytes, the same directory must instead commit immutable content-addressed
object references, byte lengths, media types, retention/access proof, and an
offline retrieval verification; a mutable URL or CI run URL is invalid.

Tasks 5.1–5.3 persist immutable output-only lanes before terminal publication:
5.1 writes `evidence/source/<digest>/**` only after source/native observation
closes; 5.2 writes `evidence/platform/<digest>/**` only after both platform
observations and zero-write oracles close; 5.3 writes `evidence/gates/<digest>/**`
only after D9 passes. A failed stage writes neither its lane nor any later lane.
These are non-decision-bearing evidence checkpoints, not D10 publication; they
contain only bounded JSON/Markdown or content-addressed references, never code,
contracts, symlinks, executables, imports, source/oracles, or another live digest.
Only after D10 candidate expectation and governance succeed may 5.4 atomically
publish `evidence/final/<digest>/**`; no evidence write is observer/launcher
authority or may touch another protected or production path.

`raw_evidence_digest` is exact: SHA-256 over the UTF-8 byte string
`shud-capability-raw-v1\0` followed by, for every raw file other than
`bundle-manifest.json`, derived `decision.{json,md}`, and derived
`publication-assertion.json` and `publication-governance-recheck.json`, the lexicographically sorted tuple
`relative_path NUL decimal_byte_length NUL sha256(file_bytes) NUL`.
The manifest records every tuple. Thus every raw counter, normalized bounded
stdout/stderr record, trace, pre/post inventory, command record, dependency graph,
SBOM, license inventory, and gate result is content-addressed. Secrets, credential
values, absolute fixture paths, raw environment dumps, and unbounded logs are not
collected at all.

`decision_projection_digest` is SHA-256 of RFC 8785 canonical JSON containing
only decision-bearing fields. The projection object itself does not contain a
`decision_projection_digest` field; derived `decision.json` stores the computed
digest beside, not inside, that hashed object:

- schema/catalog versions and catalog digest;
- frozen base SHA, source-input-record digest, fixture/oracle/frame/runner/validator/
  tripwire identities;
- lockfile, direct-feature, allowed per-target complete-graph, call-ledger,
  SBOM, and license-inventory digests plus their completeness verdicts;
- platform/target/toolchain identities;
- for every platform-row slot: row ID, expected outcome, observed outcome, exact
  rejection code and producing boundary, row verdict, oracle verdict, active
  tripwire verdicts, protection-set equality, cleanup verdict, declared limit,
  and normalized boundary class (`below|exact|exceeded`);
- every repository regression/isolation/reproducibility command ID, argv/version,
  exit verdict, bounded summary digest, and source-input-record digest;
- `run_status`, and only for `valid_complete`, the terminal decision, ordered
  first cause, and sorted all-failure codes.

It deliberately excludes timestamps, CI run/job IDs and URLs, host/user names,
temporary roots, process IDs, numeric descriptor assignments, unordered-map
order, command start/end times, raw diagnostic prose, and measured duration/CPU/
RSS/thread/traversal/hash/output counters when they remain in the same declared
boundary class. Those values remain under `raw_evidence_digest`. Absolute fixture
paths and secrets are absent rather than merely excluded from the projection.

Golden tests vary each excluded field and each below-bound counter independently:
the raw digest changes while the decision projection digest remains stable. They
also prove that changing an included identity, row outcome, boundary class,
rejection code, or gate verdict changes the projection digest. Exact-bound
evidence is valid; an evidence bundle of 8 MiB+1, a final bundle of 20 MiB+1, or a
malformed manifest is harness-invalid with no decision.

`source_input_digest_v1` is independently reproducible and has no JSON or host-ordering dependency. Its closed input set is committed as the strict LF-delimited, byte-sorted manifest
`spikes/git-status-capability/contracts/source-input-v1.paths`, which MUST list
itself and exactly:

- every Git-tracked regular source, fixture, oracle, contract/schema, lockfile,
  toolchain, launcher, validator, tripwire, native, supply, and command file under
  `spikes/git-status-capability/**`;
- `.github/workflows/git-status-capability-spike.yml`;
- this change's `.openspec.yaml`, `proposal.md`, `design.md`, `tasks.md`, and every
  `specs/**/spec.md`.

`openspec/changes/m2-capability-observer-spike/evidence/**` is the sole explicit
output exclusion and MUST NOT appear in the manifest; only the frozen
`source|platform|gates|final/<digest>/**` lanes above are admitted there.
The enumerator compares the manifest with the exact Git-tracked candidate set
under those rules. A missing/extra/duplicate entry, candidate allowlist drift,
symlink or non-regular input, non-UTF-8 path, untracked input in a candidate root,
or input whose mode/bytes differ from `SOURCE_SHA` is harness-invalid before
hashing. Repository-relative paths use `/`, are nonempty canonical UTF-8 without
NUL, absolute prefix, `.` or `..` components, and are sorted lexicographically by
their raw UTF-8 bytes.

Task 1.1 initializes this manifest from files at its own HEAD; future paths MUST
NOT be predeclared. It owns the frozen sync/check algorithm. Every task 1.2–5.1
that changes a covered file mechanically regenerates the derived manifest and
proves exact-set equality at that HEAD. This shared permission grants no semantic
ownership. Task 5.1 freezes `SOURCE_SHA` only after its workflow/supply source is
final; tasks 5.2–5.4 may add excluded evidence only and cannot update the manifest.

The framed preimage is exact:

```text
ASCII("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0")
|| u32be(entry_count)
|| for each sorted entry:
     u32be(path_byte_length)
  || path_utf8_bytes
  || u32be(git_mode_parsed_as_octal)
  || u64be(content_byte_length)
  || raw_git_blob_bytes
```

Only Git regular modes `100644` and `100755` are admitted. All integers are
unsigned big-endian and lengths count bytes, not characters. The digest is
SHA-256 of exactly that preimage. `SOURCE_SHA` is recorded beside the digest and
every input must equal that commit, but the commit ID is not hashed: a later
evidence-only commit may therefore retain the digest without making final evidence
self-referential.

Every live run invokes two independently implemented encoders, `source-input-primary-v1` (task 1.3) and `source-input-witness-v1` (task 1.2), against the same live manifest and `SOURCE_SHA`. They may share this written byte contract and synthetic fixtures only: neither may import, link, shell out to, or reuse framing/enumeration code from the other. The gate compares digest, entry count, manifest digest, and admitted path/mode set. A literal digest for the live manifest MUST NOT be committed or read as an oracle.

Only the fixed synthetic vector `contracts/goldens/source-input-v1.synthetic.frame` has a committed literal `source-input-v1.synthetic.sha256`; both encoders must independently match it. After all covered source is final, task 5.1 creates `<external-evidence-root>/source-input-record.json`, runs source/native supply checks, then persists those unchanged bytes at `evidence/source/<source-input-digest>/source-input-record.json`. Tasks 5.2/5.3 bind only its SHA-256; task 5.4 copies the same bytes into `evidence/final/<source-input-digest>/source-input-record.json`. The record contains schema/version, `SOURCE_SHA`, the sole persisted live-digest field, manifest digest, both encoder identities/results, and argv/version/exit receipt, but no self-hash. Output lanes are excluded from the preimage and never act as source or oracle.

Encoder failure/disagreement, an existing/malformed record, record drift before publication, or any committed live literal is harness-invalid, CI red, and yields no candidate or terminal publication. Synthetic goldens prove framing and manifest-order invariance; live mutation tests prove a content/path/mode/input change alters the digest, unsafe enumeration rejects, and only admitted `evidence/**` output or an evidence-only descendant commit leaves it unchanged. Any covered change invalidates every older bundle and requires both platform matrices, supply capture, and all D9 gates to rerun; an old bundle cannot be relabeled.

Task 1.1's Bun-only contract harness lives under `contracts/{check.ts,lib,tests,fixtures}/**`, writes no files, and is independent of task 1.3's stable CLI. It enforces the per-kind byte/depth/node/item table and stable ingestion codes frozen in the spec before semantic schema validation.

Tasks 5.1 and 5.2 own the fixed source/platform commands before D9:

| ID | Exact reproducible command |
|---|---|
| `PLATFORM-SOURCE-INPUT` | `spikes/git-status-capability/verify.sh source-input-digest --version 1 --source-sha <SOURCE_SHA> --manifest spikes/git-status-capability/contracts/source-input-v1.paths --primary source-input-primary-v1 --witness source-input-witness-v1 --record <external-evidence-root>/source-input-record.json --create`; task 5.1 runs it once before builds/matrices |
| `PLATFORM-NATIVE` | `spikes/git-status-capability/verify.sh native --toolchain 1.88.0 --locked --frozen`; records exact `cargo test/build/metadata/tree` argv, direct features, complete graphs, call ledger, SBOM, and license inventory |
| `PLATFORM-MATRIX` | `spikes/git-status-capability/verify.sh matrix --catalog-version 1 --git-oracle 2.49.0 --platform local`; CI runs the same command exactly once on macOS and exactly once on Linux |

### D9. Run repository and reproducibility gates before the decision

The immutable implementation base and merge-base are
`4a9748431c870fc271ec02773a4643b9453649dc`. The only implementation paths admitted
relative to that base are `spikes/git-status-capability/**`,
`.github/workflows/git-status-capability-spike.yml`, this OpenSpec change directory,
and the Phase-0.5-only `openspec/project-profile.md` update. Production packages, root/workspace manifests and lockfiles, schema
sources/generated outputs, runtime imports, release assembly, existing workflows,
canonical docs, and all four submodules are prohibited paths.

The evidence-bound source commit is recorded as `SOURCE_SHA`; the final evidence-
only commit may descend from it, but covered source bytes must retain the same
`source_input_digest_v1`. Task 1.3 owns the fixed spike-local D9 implementation;
task 5.3 only invokes it and records every command below from repository root
before candidate derivation, with Bun
`1.2.19`, OpenSpec `1.3.1`, Git oracle `2.49.0`, and Rust `1.88.0` where relevant.
The committed spike command recorder stores the exact argv/tool version, exit
code, bounded stdout/stderr summary plus its digest, and SHA-256 of the immutable source-input record
for every command ID:

| ID | Exact reproducible command / assertion |
|---|---|
| `GATE-BASE` | `test "$(git merge-base 4a9748431c870fc271ec02773a4643b9453649dc HEAD)" = 4a9748431c870fc271ec02773a4643b9453649dc` and `git merge-base --is-ancestor 4a9748431c870fc271ec02773a4643b9453649dc HEAD` |
| `GATE-SOURCE-INPUT` | `spikes/git-status-capability/verify.sh source-input-digest --version 1 --source-sha <SOURCE_SHA> --manifest spikes/git-status-capability/contracts/source-input-v1.paths --primary source-input-primary-v1 --witness source-input-witness-v1 --verify-record <external-evidence-root>/source-input-record.json --no-write`; it reruns both encoders in-memory and emits only verdict plus record SHA-256, never another live-digest field |
| `GATE-INSTALL` | `npx --yes bun@1.2.19 install --frozen-lockfile` |
| `GATE-CHECK` | `npx --yes bun@1.2.19 run check` |
| `GATE-SCHEMA` | `npx --yes bun@1.2.19 run schema:check` |
| `GATE-PERF` | `npx --yes bun@1.2.19 run test:perf:api` (the `PERF-API-001` gate) |
| `GATE-DOCS-SELF` | `scripts/docs/self_test.sh` |
| `GATE-DOCS-LINKS` | `scripts/docs/check_links.sh` |
| `GATE-OPENSPEC-STATUS` | `npx --yes @fission-ai/openspec@1.3.1 status --change m2-capability-observer-spike`; it must report 4/4 artifacts complete |
| `GATE-OPENSPEC` | `npx --yes @fission-ai/openspec@1.3.1 validate m2-capability-observer-spike --strict --no-interactive` |
| `GATE-DIFF-CHECK` | `git diff --check 4a9748431c870fc271ec02773a4643b9453649dc...HEAD` |
| `GATE-SCOPE` | `spikes/git-status-capability/verify.sh repository-scope --base 4a9748431c870fc271ec02773a4643b9453649dc`; it validates `git diff --name-status --find-renames` against the four-path allowlist above and rejects every other tracked path |
| `GATE-UNTRACKED` | `git status --porcelain=v1 --untracked-files=all` followed by `spikes/git-status-capability/verify.sh untracked-inventory`; after bounded external build outputs are removed, the inventory must be empty, including nested submodule inventories |
| `GATE-PRODUCTION` | `spikes/git-status-capability/verify.sh production-isolation --base 4a9748431c870fc271ec02773a4643b9453649dc`; it asserts zero tracked/untracked drift for `workspace/**`, `package.json`, `bun.lock`, `packages/**`, `scripts/**`, `docs/**`, existing `.github/workflows/ci.yml`, production manifests/import graph/schema/generated/release surfaces, and scans production manifests/imports/release assembly for a spike import or invocation |
| `GATE-GOVERNANCE` | `spikes/git-status-capability/verify.sh governance-handoff --repo DankerMu/SHUD-Harness --issue 132 --require-open --recovery-state blocked --pr 133 --reverted-merge 7d74a56eff27e34099961bdf14a40678c88d2603 --require-main-revert 2bf3ef8859278dd0817100c01775765612170648 --read-only`; public GET-only audit records `governance-handoff.json`, proves zero GitHub mutation calls, and rejects any state/revert/recovery mismatch |
| `GATE-SUBMODULE-DIFF` | `git diff --exit-code 4a9748431c870fc271ec02773a4643b9453649dc...HEAD -- SHUD rSHUD AutoSHUD zero` |
| `GATE-SUBMODULE-PINS` | `spikes/git-status-capability/verify.sh submodules --expect SHUD=3aec65755926c478e13ca7d4fea80715e4e90345 --expect rSHUD=2b7742e32ea323a57fd0a947dc2cea67bfd0afd1 --expect AutoSHUD=f421445340f70b8cb160ce58cefb066751628593 --expect zero=13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; it checks gitlink, checkout HEAD, recursive tracked and untracked status for all four |

`recovery_state=blocked` means #132 is OPEN while the reverted implementation is absent from `main` and production isolation still passes. The governance record contains the observed issue state, PR merge/revert SHAs, main ancestry proof, recovery state, allowed GET request ledger, and `mutation_count=0`; the harness provides no mutation credential or POST/PATCH/PUT/DELETE seam.

The macOS/Linux matrix and supply capture happen before D9. D9 consumes their
identities only to run repository/isolation/reproducibility checks and MUST NOT
derive, read, assert, or publish a candidate/terminal decision.
Any repository, isolation, reproducibility, source/input identity, command-record,
governance, or supply-completeness failure is `run_status=invalid`, CI red, and no terminal
decision. A valid row mismatch is instead a technical `rejected` decision. If a
covered digest changes after either platform ran, both platform runs and all gates
must rerun; selective reuse is forbidden.

### D10. Derive, assert, then atomically publish

Task 1.3 owns the reusable finalizer source and public-seam fault tests under `spikes/git-status-capability/{cli,finalizer}/**`; those fixed, source-digested bytes cover destination races/no-clobber, cross-device attempts, overwrite, partial-rename faults, and cleanup failure. Task 5.4 owns no finalizer source: after 5.1–5.3 bind it, task 5.4 only invokes that fixed command against a same-filesystem external staging directory. It is the sole decision/publication owner and performs this acyclic sequence after passing D9:

1. `CANDIDATE-HEALTH`: run
   `spikes/git-status-capability/verify.sh evidence health --macos <bundle> --linux <bundle> --repository-gate <gate> --output <external-staging>/candidate-decision.json`
   to revalidate both raw bundles, supply evidence, source-input digest, and D9
   record and derive the candidate `accepted|rejected` result plus Markdown there.
2. `PUBLICATION-EXPECT`: after reading that candidate, run exactly one of
   `spikes/git-status-capability/verify.sh evidence expect accepted --decision <external-staging>/candidate-decision.json`
   or the literal `rejected` variant. This is a post-derivation, pre-publication
   assertion of the public command seam. Its bounded receipt is stored as
   `publication-assertion.json`; it is publication audit metadata, not a
   decision-bearing input, is excluded from both evidence digests, and cannot feed
   back into candidate derivation.
3. `PUBLICATION-GOVERNANCE`: repeat the fixed GET-only governance assertion immediately before publication, require an exact match to D9's `governance-handoff.json`, and write `publication-governance-recheck.json`; it is excluded from both digests, cannot feed derivation, and any mutation-capable request or drift fails.
4. `FINALIZE-PUBLISH`: run `spikes/git-status-capability/verify.sh evidence publish --candidate <external-staging> --destination openspec/changes/m2-capability-observer-spike/evidence/final/<source-input-digest> --source-record openspec/changes/m2-capability-observer-spike/evidence/source/<source-input-digest>/source-input-record.json --same-filesystem --no-replace`. It rechecks both digests and unchanged source/governance records, then makes one atomic no-replace directory rename. Cross-device fallback, overwrite, merge, copy, or file-by-file publication is prohibited.

Candidate-health failure, wrong expectation/exit, governance drift/mutation, source-record or digest drift, non-atomic or partial publication, existing destination, or cleanup failure makes the run
`invalid`, CI red, and leaves the final destination absent; no staged candidate is
a published terminal result. Only successful atomic publication makes the
candidate the persisted terminal decision.

## Sketch seams under test

| Seam | Purpose | Production status |
|---|---|---|
| Spike runner/launcher | Creates disposable fixtures, freezes the oracle and payload, opens the checkout capability, performs adversarial path mutation, and launches the helper with a minimal environment. | Test/spike only |
| Native capability observer | Validates the inherited descriptor and payload, performs low-level in-memory index/HEAD versus descriptor-relative worktree comparison, and emits normalized clean/dirty or stable rejection. | Test/spike only |
| Evidence validator/decision gate | Validates the complete two-platform matrix and derives exactly one `accepted`/`rejected` result without running the observer. | Test/spike only |

No test-only seam is added to StackLock or any production package. The runner may
provide operating-system tripwire shims or a dedicated sandbox around the native
helper, but those controls must be active during the exact binary invocation whose
result is recorded.

## Mandatory parity and capability matrix

Catalog version 1 is frozen at exactly **174 row IDs** below. The committed
fixture manifest MUST contain exactly this set, these per-platform expected
outcomes, and no additional row. Every row executes exactly once on macOS and
once on Linux. There is no platform qualifier, optional row, skip,
inconclusive-as-pass, or implementer-selected “other row” state. A platform that
cannot perform a fixture emits `rejected(PLATFORM_UNSUPPORTED)`, which mismatches
the frozen expectation and makes the valid experiment technically rejected.

The pinned Git `2.49.0` oracle owns semantic clean/dirty expectations. Negative
security/resource fixtures own the exact rejection code shown. In addition to the
listed outcome, every row requires the oracle digest, active tripwire/control
identity, full protection-set zero-write oracle, descriptor/process cleanup, and
resource record; failure of any such row assertion makes `row_verdict=fail`.

### Baseline and staging (18 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `BAS-001` | clean tracked checkout | `clean` | `clean` |
| `BAS-002` | tracked content modified | `dirty` | `dirty` |
| `BAS-003` | tracked path deleted | `dirty` | `dirty` |
| `BAS-004` | tracked regular file replaced by symlink | `dirty` | `dirty` |
| `BAS-005` | tracked executable bit flipped with `core.fileMode=true` | `dirty` | `dirty` |
| `BAS-006` | empty repository with unborn `HEAD` | `clean` | `clean` |
| `STG-001` | staged add | `dirty` | `dirty` |
| `STG-002` | staged modify | `dirty` | `dirty` |
| `STG-003` | staged delete | `dirty` | `dirty` |
| `STG-004` | one path staged and then modified again | `dirty` | `dirty` |
| `STG-005` | intent-to-add entry | `dirty` | `dirty` |
| `STG-006` | conflict stages 1/2/3, both modified | `dirty` | `dirty` |
| `STG-007` | conflict stages 2/3, add/add | `dirty` | `dirty` |
| `STG-008` | conflict stages 1/2, delete/modify | `dirty` | `dirty` |
| `STG-009` | modified tracked path marked assume-unchanged | `clean` | `clean` |
| `STG-010` | modified tracked path marked skip-worktree | `clean` | `clean` |
| `STG-011` | index/worktree timestamp collision with identical bytes | `clean` | `clean` |
| `STG-012` | racy index timestamp with same-length changed bytes | `dirty` | `dirty` |

### Untracked, ignore, attributes, and effective config (35 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `UNT-001` | one untracked file | `dirty` | `dirty` |
| `UNT-002` | one untracked directory with a file | `dirty` | `dirty` |
| `UNT-003` | ignored-only content | `clean` | `clean` |
| `UNT-004` | root `.gitignore` ignores generated file | `clean` | `clean` |
| `UNT-005` | nested `.gitignore` ignores nested generated file | `clean` | `clean` |
| `UNT-006` | frozen `.git/info/exclude` ignores file | `clean` | `clean` |
| `UNT-007` | controlled `core.excludesFile` payload ignores file | `clean` | `clean` |
| `UNT-008` | host/global excludes disabled; same file is untracked | `dirty` | `dirty` |
| `UNT-009` | non-UTF-8 repository-relative untracked filename bytes | `dirty` | `dirty` |
| `ATR-001` | root `.gitattributes` text/EOL rule makes worktree canonical | `clean` | `clean` |
| `ATR-002` | nested `.gitattributes` text/EOL rule makes worktree canonical | `clean` | `clean` |
| `ATR-003` | controlled `core.attributesFile` makes worktree canonical | `clean` | `clean` |
| `ATR-004` | host/global attributes disabled; counterpart bytes differ | `dirty` | `dirty` |
| `ATR-005` | frozen `.git/info/attributes` text/EOL rule makes worktree canonical | `clean` | `clean` |
| `CFG-001` | `core.autocrlf=true`, canonical CRLF worktree | `clean` | `clean` |
| `CFG-002` | `core.autocrlf=false`, same CRLF worktree | `dirty` | `dirty` |
| `CFG-003` | `core.eol=lf` with text attribute and LF worktree | `clean` | `clean` |
| `CFG-004` | `core.eol=crlf` with text attribute and CRLF worktree | `clean` | `clean` |
| `CFG-005` | `core.fileMode=true`, executable bit changed | `dirty` | `dirty` |
| `CFG-006` | `core.fileMode=false`, executable bit changed | `clean` | `clean` |
| `CFG-007` | controlled case-sensitive volume, tracked filename case-changed, `core.ignoreCase=true` | `clean` | `clean` |
| `CFG-008` | same controlled volume and case change, `core.ignoreCase=false` | `dirty` | `dirty` |
| `CFG-009` | `core.trustctime=true`, ctime-only change, same bytes | `clean` | `clean` |
| `CFG-010` | `core.trustctime=false`, ctime-only change, same bytes | `clean` | `clean` |
| `CFG-011` | `core.checkStat=default`, stat-only change, same bytes | `clean` | `clean` |
| `CFG-012` | `core.checkStat=minimal`, stat-only change, same bytes | `clean` | `clean` |
| `CFG-013` | `core.ignoreStat=true`, same-size/restored-mtime byte change | `clean` | `clean` |
| `CFG-014` | `core.ignoreStat=false`, same-size/restored-mtime byte change | `dirty` | `dirty` |
| `CFG-015` | true aliases `yes`, `on`, and `1` across boolean keys | `dirty` | `dirty` |
| `CFG-016` | false aliases `no`, `off`, and `0` across boolean keys | `clean` | `clean` |
| `CFG-017` | valueless Git boolean interpreted as true | `dirty` | `dirty` |
| `CFG-018` | invalid Git boolean token in frozen effective config | `rejected(CONFIG_BOOLEAN_INVALID)` | `rejected(CONFIG_BOOLEAN_INVALID)` |
| `CFG-019` | repository-local config/include makes `core.ignoreStat=true` | `clean` | `clean` |
| `CFG-020` | `extensions.worktreeConfig` worktree config makes it true | `clean` | `clean` |
| `CFG-021` | nested included config makes nested `core.ignoreStat=true` | `clean` | `clean` |

### Index, repository layout, and nested checkout state (37 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `IDX-001` | index v2 clean | `clean` | `clean` |
| `IDX-002` | index v2 tracked content modified | `dirty` | `dirty` |
| `IDX-003` | index v4 clean | `clean` | `clean` |
| `IDX-004` | index v4 tracked content modified | `dirty` | `dirty` |
| `IDX-005` | split index plus valid shared index clean | `clean` | `clean` |
| `IDX-006` | split index plus valid shared index modified | `dirty` | `dirty` |
| `IDX-007` | split-index shared material missing | `rejected(INDEX_SHARED_MISSING)` | `rejected(INDEX_SHARED_MISSING)` |
| `IDX-008` | split-index shared material corrupt | `rejected(INDEX_SHARED_CORRUPT)` | `rejected(INDEX_SHARED_CORRUPT)` |
| `IDX-009` | malformed index signature/version | `rejected(INDEX_MALFORMED)` | `rejected(INDEX_MALFORMED)` |
| `IDX-010` | truncated index | `rejected(INDEX_TRUNCATED)` | `rejected(INDEX_TRUNCATED)` |
| `IDX-011` | oversized index payload | `rejected(LIMIT_INDEX_BYTES)` | `rejected(LIMIT_INDEX_BYTES)` |
| `IDX-012` | linked worktree with split index, clean | `clean` | `clean` |
| `IDX-013` | linked worktree with split index, tracked content modified | `dirty` | `dirty` |
| `IDX-014` | initialized nested checkout with split index, clean | `clean` | `clean` |
| `IDX-015` | initialized nested checkout with split index, tracked content modified | `dirty` | `dirty` |
| `IDX-016` | stage-1 gitlink conflict | `rejected(INDEX_GITLINK_CONFLICT)` | `rejected(INDEX_GITLINK_CONFLICT)` |
| `IDX-017` | stage-2 gitlink conflict | `rejected(INDEX_GITLINK_CONFLICT)` | `rejected(INDEX_GITLINK_CONFLICT)` |
| `IDX-018` | stage-3 gitlink conflict | `rejected(INDEX_GITLINK_CONFLICT)` | `rejected(INDEX_GITLINK_CONFLICT)` |
| `IDX-019` | unknown stage-4 gitlink frame record | `rejected(INDEX_STAGE_UNKNOWN)` | `rejected(INDEX_STAGE_UNKNOWN)` |
| `IDX-020` | malformed gitlink index frame record | `rejected(INDEX_MALFORMED)` | `rejected(INDEX_MALFORMED)` |
| `LAY-001` | normal `.git` directory checkout | `clean` | `clean` |
| `LAY-002` | `.git` file indirection represented only in payload | `clean` | `clean` |
| `LAY-003` | linked worktree clean | `clean` | `clean` |
| `LAY-004` | linked worktree tracked modification | `dirty` | `dirty` |
| `NES-001` | initialized direct stage-0 nested checkout clean | `clean` | `clean` |
| `NES-002` | initialized direct stage-0 nested checkout dirty despite repo-local `ignore=all` | `dirty` | `dirty` |
| `NES-003` | present deinitialized direct stage-0 nested checkout | `clean` | `clean` |
| `NES-004` | stably absent direct stage-0 nested checkout | `dirty` | `dirty` |
| `NES-005` | initialized recursive stage-0 nested checkout clean | `clean` | `clean` |
| `NES-006` | initialized recursive stage-0 nested checkout dirty despite repo-local `ignore=all` | `dirty` | `dirty` |
| `NES-007` | stably absent recursive stage-0 nested checkout | `dirty` | `dirty` |
| `NES-008` | absent stage-0 nested path appears after frozen audit | `rejected(NESTED_STATE_CHANGED)` | `rejected(NESTED_STATE_CHANGED)` |
| `NES-009` | deinitialized stage-0 nested path disappears after frozen audit | `rejected(NESTED_STATE_CHANGED)` | `rejected(NESTED_STATE_CHANGED)` |
| `NES-010` | deinitialized stage-0 nested path is replaced at the same pathname after audit | `rejected(NESTED_STATE_CHANGED)` | `rejected(NESTED_STATE_CHANGED)` |
| `NES-011` | LF-containing stage-0 gitlink path reaches recursive required-filter audit | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `NES-012` | U+2028-containing stage-0 gitlink path reaches recursive required-filter audit | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `NES-013` | U+2029-containing stage-0 gitlink path reaches recursive required-filter audit | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |

### Capability, framing, and replay attacks (17 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `CAP-001` | admitted clean checkout renamed; original name replaced by directory | `clean` | `clean` |
| `CAP-002` | admitted clean checkout renamed; original name replaced by symlink | `clean` | `clean` |
| `CAP-003` | admitted clean checkout renamed; original name replaced by regular file | `clean` | `clean` |
| `CAP-004` | admitted empty clean checkout directory unlinked while descriptor remains open | `clean` | `clean` |
| `CAP-005` | designated descriptor absent | `rejected(DESCRIPTOR_MISSING)` | `rejected(DESCRIPTOR_MISSING)` |
| `CAP-006` | designated descriptor closed before exec | `rejected(DESCRIPTOR_CLOSED)` | `rejected(DESCRIPTOR_CLOSED)` |
| `CAP-007` | designated descriptor references regular file | `rejected(DESCRIPTOR_NOT_DIRECTORY)` | `rejected(DESCRIPTOR_NOT_DIRECTORY)` |
| `CAP-008` | descriptor number not in exact allowlist | `rejected(DESCRIPTOR_NOT_ALLOWLISTED)` | `rejected(DESCRIPTOR_NOT_ALLOWLISTED)` |
| `CAP-009` | unexpected second alias descriptor inherited | `rejected(DESCRIPTOR_ALIAS)` | `rejected(DESCRIPTOR_ALIAS)` |
| `CAP-010` | payload byte changed after freeze | `rejected(FRAME_CHECKSUM)` | `rejected(FRAME_CHECKSUM)` |
| `CAP-011` | payload truncated by one byte | `rejected(FRAME_TRUNCATED)` | `rejected(FRAME_TRUNCATED)` |
| `CAP-012` | valid frame followed by a surplus frame | `rejected(FRAME_SURPLUS)` | `rejected(FRAME_SURPLUS)` |
| `CAP-013` | payload contains absolute path | `rejected(PATH_ABSOLUTE)` | `rejected(PATH_ABSOLUTE)` |
| `CAP-014` | payload contains `..` escape | `rejected(PATH_ESCAPE)` | `rejected(PATH_ESCAPE)` |
| `CAP-015` | frame replayed with foreign checkout descriptor | `rejected(REPLAY_FOREIGN_CHECKOUT)` | `rejected(REPLAY_FOREIGN_CHECKOUT)` |
| `CAP-016` | prior generation replayed after Git-state generation changes | `rejected(REPLAY_STALE_GENERATION)` | `rejected(REPLAY_STALE_GENERATION)` |
| `CAP-017` | frame/generation replayed under another row ID | `rejected(REPLAY_CROSS_ROW)` | `rejected(REPLAY_CROSS_ROW)` |

### Helper and network nonexecution (17 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `HLP-001` | executable repository hooks configured on clean fixture | `clean` | `clean` |
| `HLP-002` | executable main-checkout fsmonitor configured on clean fixture | `clean` | `clean` |
| `HLP-003` | main-checkout repo-local clean/smudge process filter required for tracked content | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-004` | external diff driver configured on modified tracked file | `dirty` | `dirty` |
| `HLP-005` | credential/askpass helpers and remote configured | `clean` | `clean` |
| `HLP-006` | pager, editor, and shell tripwires configured | `clean` | `clean` |
| `HLP-007` | promisor remote plus network tripwire configured | `clean` | `clean` |
| `HLP-008` | main checkout worktree-config clean filter required | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-009` | linked worktree worktree-config clean filter required | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-010` | nested checkout worktree-config clean filter required | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-011` | main checkout worktree-config includes required process filter | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-012` | linked worktree worktree-config includes required process filter | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-013` | nested checkout worktree-config includes required process filter | `rejected(EXTERNAL_FILTER_REQUIRED)` | `rejected(EXTERNAL_FILTER_REQUIRED)` |
| `HLP-014` | main checkout helper injected after audit cannot execute | `dirty` | `dirty` |
| `HLP-015` | linked worktree helper injected after audit cannot execute | `dirty` | `dirty` |
| `HLP-016` | nested checkout helper injected after audit cannot execute | `dirty` | `dirty` |
| `HLP-017` | executable nested-checkout fsmonitor configured on clean fixture | `clean` | `clean` |

No helper/network sentinel may execute in any `HLP-*` row, including the expected
filter rejection.

### Issue #132 evidence-floor crosswalk (25 independent rows)

The reverted PR #133 evidence floor is frozen below as a bijection: each floor ID maps to one new mandatory catalog row and no row covers two floor IDs. Git `2.49.0` owns clean/dirty semantics; the named rejection plus a zero-execution marker owns negative/helper semantics. The catalog contract rejects a missing, duplicate, merged, or differently owned crosswalk entry.

| Floor ID and independently observable case | Catalog row | Fixture/native owner | Exact oracle |
|---|---|---|---|
| `F132-01` linked split-index clean | `IDX-012` | 2.3 / 4.4 | Git `clean` |
| `F132-02` linked split-index dirty | `IDX-013` | 2.3 / 4.4 | Git `dirty` |
| `F132-03` nested split-index clean | `IDX-014` | 2.3 / 4.4 | Git `clean` |
| `F132-04` nested split-index dirty | `IDX-015` | 2.3 / 4.4 | Git `dirty` |
| `F132-05` absent nested path appears after audit | `NES-008` | 2.3 / 4.5 | `NESTED_STATE_CHANGED` |
| `F132-06` deinitialized nested path disappears after audit | `NES-009` | 2.3 / 4.5 | `NESTED_STATE_CHANGED` |
| `F132-07` nested same-path replacement after audit | `NES-010` | 2.3 / 4.5 | `NESTED_STATE_CHANGED` |
| `F132-08` LF stage-0 gitlink recursion | `NES-011` | 2.3 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-09` U+2028 stage-0 gitlink recursion | `NES-012` | 2.3 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-10` U+2029 stage-0 gitlink recursion | `NES-013` | 2.3 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-11` stage-1 gitlink conflict | `IDX-016` | 2.3 / 4.4 | `INDEX_GITLINK_CONFLICT`; status/helper absent |
| `F132-12` stage-2 gitlink conflict | `IDX-017` | 2.3 / 4.4 | `INDEX_GITLINK_CONFLICT`; status/helper absent |
| `F132-13` stage-3 gitlink conflict | `IDX-018` | 2.3 / 4.4 | `INDEX_GITLINK_CONFLICT`; status/helper absent |
| `F132-14` unknown gitlink stage | `IDX-019` | 2.3 / 4.4 | `INDEX_STAGE_UNKNOWN`; status absent |
| `F132-15` malformed gitlink record | `IDX-020` | 2.3 / 4.4 | `INDEX_MALFORMED`; status absent |
| `F132-16` main worktree-config clean filter | `HLP-008` | 2.4 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-17` linked worktree-config clean filter | `HLP-009` | 2.4 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-18` nested worktree-config clean filter | `HLP-010` | 2.4 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-19` main included process filter | `HLP-011` | 2.4 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-20` linked included process filter | `HLP-012` | 2.4 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-21` nested included process filter | `HLP-013` | 2.4 / 4.6 | `EXTERNAL_FILTER_REQUIRED`; marker absent |
| `F132-22` main audit→inject helper | `HLP-014` | 2.4 / 4.6 | Git `dirty`; marker absent |
| `F132-23` linked audit→inject helper | `HLP-015` | 2.4 / 4.6 | Git `dirty`; marker absent |
| `F132-24` nested audit→inject helper | `HLP-016` | 2.4 / 4.6 | Git `dirty`; marker absent |
| `F132-25` nested fsmonitor | `HLP-017` | 2.4 / 4.6 | Git `clean`; marker absent |

### Collection-wide protection and mutation attacks (12 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `PRT-001` | TMPDIR is canonical superproject root | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-002` | TMPDIR is published `SHUD` checkout | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-003` | TMPDIR is published `rSHUD` checkout | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-004` | TMPDIR is published `AutoSHUD` checkout | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-005` | TMPDIR is published `zero` checkout | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-006` | TMPDIR is initialized nested checkout | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-007` | TMPDIR is admitted fixture checkout, repeated through its physical alias | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-008` | TMPDIR reaches protected object through symlink alias | `rejected(PROTECTED_TMPDIR)` | `rejected(PROTECTED_TMPDIR)` |
| `PRT-009` | evidence/output path pre-created inside protected member | `rejected(PROTECTED_OUTPUT_PATH)` | `rejected(PROTECTED_OUTPUT_PATH)` |
| `PRT-010` | controlled create-then-delete attempt during exact invocation | `rejected(PROTECTED_WRITE_ATTEMPT)` | `rejected(PROTECTED_WRITE_ATTEMPT)` |
| `PRT-011` | controlled chmod/utime attempt during exact invocation | `rejected(PROTECTED_METADATA_ATTEMPT)` | `rejected(PROTECTED_METADATA_ATTEMPT)` |
| `PRT-012` | controlled index-refresh/lock/object-write attempt | `rejected(PROTECTED_GIT_WRITE_ATTEMPT)` | `rejected(PROTECTED_GIT_WRITE_ATTEMPT)` |

Each controlled fault is injected at the public OS filesystem boundary surrounding
the exact observer binary; the same tripwire must first prove it detects the
control and then remain quiet for the unfaulted invocation.

### Exact resource bounds (26 rows)

The frozen limits are: frame 8 MiB; index material 6 MiB; 50,000 index entries;
512 bytes per relative path; depth 16; 16 nested repositories; 200,000 traversal
entries; 256 MiB hashed bytes; 10,000 ms wall; 5,000 ms CPU; 4 threads; 512 MiB
address-space/RSS ceiling; and 256 KiB combined stdout/stderr. Every exact row is
allowed; every smallest representable overage returns only the named code.

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `LIM-001` | frame exactly 8 MiB | `clean` | `clean` |
| `LIM-002` | frame 8 MiB + 1 byte | `rejected(LIMIT_FRAME_BYTES)` | `rejected(LIMIT_FRAME_BYTES)` |
| `LIM-003` | index material exactly 6 MiB | `clean` | `clean` |
| `LIM-004` | index material 6 MiB + 1 byte | `rejected(LIMIT_INDEX_BYTES)` | `rejected(LIMIT_INDEX_BYTES)` |
| `LIM-005` | exactly 50,000 index entries | `clean` | `clean` |
| `LIM-006` | 50,001 index entries | `rejected(LIMIT_INDEX_ENTRIES)` | `rejected(LIMIT_INDEX_ENTRIES)` |
| `LIM-007` | longest relative path exactly 512 bytes | `clean` | `clean` |
| `LIM-008` | relative path 513 bytes | `rejected(LIMIT_PATH_BYTES)` | `rejected(LIMIT_PATH_BYTES)` |
| `LIM-009` | relative path depth exactly 16 | `clean` | `clean` |
| `LIM-010` | relative path depth 17 | `rejected(LIMIT_PATH_DEPTH)` | `rejected(LIMIT_PATH_DEPTH)` |
| `LIM-011` | exactly 16 nested repositories | `clean` | `clean` |
| `LIM-012` | 17 nested repositories | `rejected(LIMIT_NESTED_REPOSITORIES)` | `rejected(LIMIT_NESTED_REPOSITORIES)` |
| `LIM-013` | exactly 200,000 traversal entries | `clean` | `clean` |
| `LIM-014` | traversal entry 200,001 | `rejected(LIMIT_TRAVERSAL_ENTRIES)` | `rejected(LIMIT_TRAVERSAL_ENTRIES)` |
| `LIM-015` | exactly 256 MiB hashed bytes | `clean` | `clean` |
| `LIM-016` | 256 MiB + 1 hashed byte | `rejected(LIMIT_HASHED_BYTES)` | `rejected(LIMIT_HASHED_BYTES)` |
| `LIM-017` | deterministic work reaches exactly 10,000 ms wall budget | `clean` | `clean` |
| `LIM-018` | deterministic work reaches 10,001 ms wall budget | `rejected(LIMIT_WALL_TIME)` | `rejected(LIMIT_WALL_TIME)` |
| `LIM-019` | deterministic work reaches exactly 5,000 ms CPU budget | `clean` | `clean` |
| `LIM-020` | deterministic work exceeds CPU budget by one accounting tick | `rejected(LIMIT_CPU_TIME)` | `rejected(LIMIT_CPU_TIME)` |
| `LIM-021` | exactly 4 observer threads | `clean` | `clean` |
| `LIM-022` | attempted fifth observer thread | `rejected(LIMIT_THREADS)` | `rejected(LIMIT_THREADS)` |
| `LIM-023` | allocator reaches exact 512 MiB memory ceiling | `clean` | `clean` |
| `LIM-024` | allocation exceeds memory ceiling by one byte | `rejected(LIMIT_MEMORY)` | `rejected(LIMIT_MEMORY)` |
| `LIM-025` | combined stdout/stderr exactly 256 KiB | `clean` | `clean` |
| `LIM-026` | combined stdout/stderr 256 KiB + 1 byte | `rejected(LIMIT_OUTPUT_BYTES)` | `rejected(LIMIT_OUTPUT_BYTES)` |

### Lifecycle, cleanup, and determinism (12 rows)

| ID | Frozen fixture | macOS expected | Linux expected |
|---|---|---|---|
| `LIF-001` | successful observation closes every owned descriptor/process | `clean` | `clean` |
| `LIF-002` | unsupported frame version plus normal cleanup | `rejected(FRAME_VERSION_UNSUPPORTED)` | `rejected(FRAME_VERSION_UNSUPPORTED)` |
| `LIF-003` | bounded timeout and reap | `rejected(TIMEOUT)` | `rejected(TIMEOUT)` |
| `LIF-004` | tested `SIGTERM` interruption and reap | `rejected(SIGNALLED_TERM)` | `rejected(SIGNALLED_TERM)` |
| `LIF-005` | tested `SIGKILL` interruption and reap | `rejected(SIGNALLED_KILL)` | `rejected(SIGNALLED_KILL)` |
| `LIF-006` | primary frame-version error plus cleanup failure | `rejected(FRAME_VERSION_UNSUPPORTED)` | `rejected(FRAME_VERSION_UNSUPPORTED)` |
| `LIF-007` | successful observation followed by cleanup-only failure | `rejected(CLEANUP_FAILED)` | `rejected(CLEANUP_FAILED)` |
| `LIF-008` | parallel fixture invocations retain descriptor/process baselines | `clean` | `clean` |
| `DET-001` | byte-identical same-checkout/same-generation repeat | `clean` | `clean` |
| `DET-002` | fixture creation order permuted | `clean` | `clean` |
| `DET-003` | disposable fixture root changed | `clean` | `clean` |
| `DET-004` | timestamps/map order/below-bound counters varied | `clean` | `clean` |

`LIF-006` additionally requires the frame-version code to remain primary and the
cleanup code to appear only in the ordered secondary-error array. `DET-*` compare
normalized row output and decision projection, while their differing raw counters
remain content-addressed by the raw digest.

## Risk-pack selection

Fixture level is **expanded** and repair intensity is **high** because the change
adds a native dependency experiment, a process protocol, descriptor/file access,
cross-platform CI, and an acceptance decision that may influence future
architecture.

| Risk pack | Selection | Evidence obligation |
|---|---|---|
| Public API / entrypoint | Selected | Versioned runner/helper/validator CLI contracts; malformed argv/stdin/stdout cases |
| Config / setup | Selected | Pinned effective Git config corpus; minimal environment; no host/global config leakage |
| File I/O / path | Selected | Descriptor-only authority, path-replacement attacks, no-follow behavior, protected-root mutation oracle |
| Schema / fields | Selected | Strict evidence/payload/decision schema versions, duplicate/unknown/boundary fields |
| Auth / secrets | Not selected as a product auth surface | Environment allowlist and credential noninheritance are nevertheless required by D7 |
| Concurrency / ordering | Selected | Frozen oracle/payload before attack, descriptor lifetime, repeated/parallel fixture isolation |
| Resource limits | Selected | Exact-bound/bound-plus-one and timeout/signal/cleanup rows |
| Legacy / parity | Selected | Pinned Git oracle, index formats, split index, linked/nested worktrees, macOS/Linux parity |
| Error / rollback | Selected | Stable rejection taxonomy, no fallback, causal error precedence, deletion-only rollback |
| Release / packaging | Selected | Toolchain/dependency lock, feature graph, license/SBOM, non-production isolation |
| Documentation / migration | Selected | Reproduction commands, accepted/rejected implications, later-change boundary |
| Scientific governance | Not selected | No hydrological model, parameter, evidence claim, or PI scientific decision changes |
| SHUD/rSHUD/AutoSHUD compatibility | Not selected | Read-only submodules are untouched and verified unchanged |
| Zero/agent runtime governance | Not selected | Zero submodule and runtime adapter are untouched and verified unchanged |

## Invariant Matrix

| Stage | Authority / invariant | Enforcement and evidence |
|---|---|---|
| Fixture setup | Disposable repository and pinned Git oracle are the only setup authorities. | Exact 174-ID manifest plus 25-ID #132-floor bijection; fixture root outside protected project data; expected result and generation frozen before observation. |
| Capability admission | One directory descriptor identifies the checkout object; no pathname identity is trusted afterward. | `fstat` identity/type, allowlisted descriptor inventory, rename/replace fixtures, no `/proc` or `/dev/fd` traversal. |
| Git-state transport | One immutable, bounded, checksummed frame fully describes the attempted Git baseline and replay identity. | Strict decoder; checkout/row/observation/generation digest validation before traversal; split/nested state explicit. |
| Observation | Only descriptor-relative checkout reads and in-memory Git-state operations influence clean/dirty. | Active filesystem/process/network and collection-wide zero-write tripwires; transitive call ledger; bounded resource counters. |
| Row verdict | Exact expected negative rejection is a pass; unexpected semantic rejection/unsupported is a fail. | Closed `observer_outcome`, expected outcome and exact-code comparator; first-cause plus cleanup arrays. |
| Harness validity | Missing/duplicate/corrupt/stale evidence, inactive controls, supply/gate failure, or digest drift is not a technology result. | `run_status=invalid`, CI red, no terminal decision, complete rerun required. |
| Evidence | Every row is present exactly once per platform and bound to exact source/toolchain/dependencies/platform. | Exact raw digest, stable projection digest, persistent bounded bundle, two-platform cross-binding. |
| Decision | Acceptance is possible only after all rows and all repository/supply/governance gates pass. | `valid_complete` plus all 348 verdicts pass -> accepted; valid row fail -> rejected; expectation assertion remains separate. |
| Promotion | Spike artifacts do not become production dependencies or close Issue #132. | Import/package/release diff guards; later OpenSpec/ADR and human merge gate required. |

## Implementation phases and dependency order

Each checkbox in `tasks.md` is one single-session, small-PR ownership boundary;
none is a change-sized umbrella. Every slice uses `fixture=expanded`,
`repair=high`, has explicit In/Out paths, and is independently mergeable while
remaining non-production. The dependency DAG is:

```text
1.1 frozen catalog/schemas
 ├─> 1.2 validator/state goldens ─> 1.3 CLI/finalizer/repository-gate source
 ├─> 2.1 baseline/staging/true-untracked oracle ┐
 ├─> 2.2 ignore/exclude/attribute/config oracle │
 ├─> 2.3 index/layout/nested floor oracle ├─ semantic prerequisite set
 ├─> 2.4 attack/helper/protection oracle  │
 └─> 2.5 limits/lifecycle oracle  ┘
1.1 + 2.4 + 2.5 ─> 3.1 launcher/evidence-emitter source ─> 3.2 active tripwires/protection
1.3 + 3.2 ─> 4.1 native transport (no semantic pass claim)
1.2 + 2.1 + 3.2 + 4.1 ─> 4.2 baseline/staging/true-untracked
1.2 + 2.2 + 3.2 + 4.1 ─> 4.3 ignore/exclude/attribute/config
1.2 + 2.3 + 3.2 + 4.1 ─> 4.4 index/split-index
1.2 + 2.3 + 3.2 + 4.1 + 4.4 ─> 4.5 layout/nested
1.2 + 2.4 + 3.2 + 4.1 + 4.2 + 4.3 + 4.5 ─> 4.6 attacks/helpers/replay
1.2 + 2.5 + 3.2 + 4.1 + 4.2 + 4.6 ─> 4.7 limits/lifecycle
4.2..4.7 ─> 5.1 dual-platform CI/supply ─> 5.2 complete raw evidence
5.2 ─> 5.3 repository regression/isolation/reproducibility gate
1.3 + 5.3 ─> 5.4 external candidate ─> expect assertion ─> atomic publication
```

The catalog ownership partition is frozen and exhaustive:

| Row partition | Fixture owner | Native owner | Count |
|---|---|---|---:|
| `BAS-001..006`, `STG-001..012`, `UNT-001`, `UNT-002`, `UNT-009` | 2.1 | 4.2 | 21 |
| `UNT-003..008`, `ATR-001..005`, `CFG-001..021` | 2.2 | 4.3 | 32 |
| `IDX-001..020` | 2.3 | 4.4 | 20 |
| `LAY-001..004`, `NES-001..010` | 2.3 | 4.5 | 14 |
| `NES-011..013` | 2.3 | 4.6 | 3 |
| `CAP-001..017`, `HLP-001..017`, `PRT-001..012` | 2.4 | 4.6 | 46 |
| `LIM-001..026`, `LIF-001..008`, `DET-001..004` | 2.5 | 4.7 | 38 |
| **Exact total** | **one owner per row** | **one owner per row** | **174** |

Task 1.1 validates both ownership columns as exact partitions of the catalog; an
overlap, gap, or row claimed by another checkbox is a contract failure.
Task 4.6 depends on 4.5 specifically so nested helper/fsmonitor and audit→inject controls exercise the completed descriptor-bound nested observer rather than a stub or parent-only path.

The hard semantic gate is mechanical: no `BAS/STG/UNT/ATR/CFG/IDX/LAY/NES` row
may be recorded as pass until task 1.1's exact catalog, task 1.2's validator, the
row's task-2 oracle, and task 3.2's live path/process/network/write tripwires all
exist and are identity-bound to the same `source_input_digest_v1`. Task 4.1 may prove only
transport and negative contract rows. Focused semantic test output created earlier
is development feedback, never decision-bearing evidence.

Task 5.4 is the only owner of a published `terminal_decision`. All covered source
is owned by tasks 1.1–5.1; tasks 5.2/5.3 commit only excluded platform/gate evidence. Task 5.3 executes
after the complete two-platform matrix, contributes only pre-decision gate inputs,
and never reads a decision. Task 5.4 follows D10's candidate→assert→atomic-publish
sequence; the assertion cannot point back into D9. Changing any covered
source/input after 5.1 invalidates 5.1–5.3 outputs and sends the DAG back to both
platform runs; a later gate cannot bless stale evidence.

Both terminal values share one unconditional governance handoff: D9 and the pre-publication recheck prove #132 remains open with `recovery_state=blocked`, PR #133's merge remains reverted from `main`, and every GitHub interaction was read-only. Both summaries persist those facts locally. This change sends no comment and mutates no issue or PR; any integration, close, merge, or promotion requires a separate reviewed OpenSpec+ADR and explicit human approval.

No phase integrates the result into StackLock. For either terminal value, local summaries may reference causal evidence but cannot mutate GitHub; a later OpenSpec+ADR must cover process/FFI boundaries, packaging, dependency policy, migration, release/runtime failures, and StackLock integration before explicit human-gated architecture review.

## Risks / Trade-offs

| Risk / trade-off | Mitigation |
|---|---|
| Low-level gix still reaches ambient paths internally. | Active syscall/filesystem tripwires plus call ledger; any access rejects the approach. |
| The payload quietly becomes an unbounded reimplementation of a Git directory. | Explicit schema and budgets; only fields demanded by mandatory rows; size/entry/depth exact-bound tests. |
| Git parity depends on filters, fsmonitor, or other external commands. | Helper execution is prohibited; an unexpected semantic rejection fails its row and yields technical rejection rather than invoking helpers or weakening parity. |
| CI reports green although the technology was rejected. | Terminal decision is displayed and persisted; separate `expect accepted` exists for later consumers; the local summary states the decision without GitHub mutation. |
| Toolchain installation contaminates the TypeScript production stack. | Dedicated spike boundary, no workspace membership/import/release hook, diff guards, and deletion-only rollback. |
| Platform-specific filesystem behavior produces misleading equivalence. | Same semantic row IDs on both OS, platform metadata retained, no skip, and cross-platform validator. |
| Fixture oracle and observer share mutable state. | Freeze expected output/payload first, then cross the observation boundary and apply adversarial mutations. |
| Dependency or license footprint is unsuitable for production. | Record full locked graph and licenses; acceptance proves capability only and grants no production adoption. |

## Migration Plan

There is no production migration. Land the small-PR DAG in dependency order, run
the complete two-platform matrix and post-matrix gates, then publish one bound
terminal decision. The
change can be rolled back by deleting the isolated spike artifacts and CI entry;
no production data, schema, runtime, or package requires migration.

Either terminal result remains local evidence and carries the same immutable governance handoff; neither mutates #132/#133 or authorizes production code. An integration after `accepted` or another architecture after `rejected` each requires its own reviewed OpenSpec+ADR and explicit human approval.

## Open Questions

None for spike execution. Task 1.1 commits the exact direct crate versions/features,
lockfile, and target graph catalog before launcher/native work; no semantic task
may select or update them. Rust is fixed at `1.88.0`, Git oracle at `2.49.0`, Bun
at `1.2.19`, OpenSpec at `1.3.1`, and the frozen implementation base is
`4a9748431c870fc271ec02773a4643b9453649dc`. The accept/reject result remains
intentionally unknown until task 5.4 consumes valid complete evidence and the
post-matrix repository gate.
