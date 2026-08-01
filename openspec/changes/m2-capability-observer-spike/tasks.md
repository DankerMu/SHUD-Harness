## Execution boundary for every checkbox

Every checkbox below is one independently reviewable, single-session small PR and
one exclusive ownership boundary. No checkbox means “finish the change.” Every
slice uses `fixture=expanded`, `repair=high`, adds requirement-driven tests at the
named public seam, proves those tests bite with one batched source-only red run,
and leaves a runnable non-production spike. “In” is the permitted implementation
surface for that slice; “Out” is deliberately owned by later slices. A semantic
row MUST NOT be claimed pass until the frozen catalog, validator, that row's
pinned-Git oracle, and active tripwires are ready at one source-input digest.
Unless a path is repository-absolute in prose, abbreviated paths such as
`native/**` and `oracle/**` are relative to `spikes/git-status-capability/`.
The row partitions in design are exhaustive: every catalog ID has exactly one
task-2 fixture owner and one task-4 native owner, and no checkbox may absorb a row
owned by another checkbox.
The sole shared generated-file exception is `contracts/source-input-v1.paths`:
task 1.1 owns its sync/check algorithm and initial current-HEAD content; every task
1.2–5.1 that adds/removes/renames a covered candidate has implicit In permission
to regenerate only this file, MUST list no future path, and MUST run the exact-set
check. This mechanical update grants no semantic contract ownership. Tasks 5.2–5.4
add only bounded output under excluded `evidence/**` lanes and never update it.

## 1. Frozen contract and validator

- [ ] 1.1 Freeze catalog v1, schemas, rejection taxonomy, limits, and dependency contract.
  - PR boundary: contract only; minimal mergeable slice is a Bun-only strict schema/catalog checker plus golden valid/invalid fixtures, with no launcher, observer, validator decision, or stable task-1.3 CLI.
  - In: `spikes/git-status-capability/contracts/**`, specifically `contracts/{check.ts,lib,tests,fixtures}/**`, `source-input-v1.paths`, the synthetic-only `goldens/source-input-v1.synthetic.{frame,sha256}`, `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, and `dependency-graph-catalog.json`; exact 174 IDs/outcomes, exact 25-floor-ID bijection, exhaustive fixture/native ownership maps, four-layer state schema, exact `source_input_digest_v1` frame/record, frame/evidence/bundle/decision schemas, Rust `1.88.0`, Git `2.49.0`, direct crates/features, target graph predicates, and all finite ingestion/observer limits. Phase 0.5 may also update `openspec/project-profile.md` only to register this new isolated surface. The checker uses Bun standard APIs only and writes no files.
  - Out: validator decisions, fixture recipes, process launch, native source, CI, raw evidence, production paths.
  - Depends on: none.
  - Verification: first run `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests` with only `contracts/{check.ts,lib}/**` source stashed; every new-behavior test must be red, then restore source and require green. The same command covers valid/exact/bound+1, invalid UTF-8, malformed/trailing/duplicate/deep/wide JSON, unknown/missing fields, stable codes, exit/stdout/stderr, no partial output, manifest missing/extra/future/duplicate/skip/platform-conditional rows, floor merge/gap, ownership overlap/gap, synthetic-only literal, unsafe paths, floating dependencies, and inclusive observer limits. Then `npx --yes bun@1.2.19 spikes/git-status-capability/contracts/check.ts --repository-root . --manifest spikes/git-status-capability/contracts/source-input-v1.paths --check-current` must emit one success receipt without writes; no launcher/observer/`verify.sh` command runs.

### Issue #171 core-ingress delivery overlay

This overlay is the active implementation fixture for #171. It re-slices only
the core behavior lane from superseded PR #170. Task 1.1 remains incomplete:
#172 owns exhaustive hostile-source AST/preload proof and historical evidence
reconciliation; #169 owns the committed-current oracle and final Task 1.1a
ownership rewrite.

Fixture level: `expanded`; repair intensity: `high`; upstream suggestion:
`expanded` (agree). Selected risk packs are Public API / CLI, File IO / path
safety, Schema / fields, Resource limits, Legacy compatibility, and Error /
rollback. Config/setup, auth/secrets, concurrency/shared state, release/
packaging, documentation/migration, scientific governance, SHUD/rSHUD/AutoSHUD,
Zero/runtime governance, production runtime, and network security are not
selected because this slice changes neither those authorities nor their
artifacts.

- [x] #171.A Re-slice retained descriptor capabilities for both direct kinds.
  - In: `contracts/{check.ts,lib/{ingress,capabilities,checker,canonical-json,constants,schemas}.ts,fixtures,tests}/**` needed by `source_input_record` and `source_identity_projection` only.
  - Out: `tests/authority-preload.ts`, exhaustive hostile-source mutation/AST closure, historical review evidence, committed-current behavior, live Git, evidence publication, production/runtime, workflows, and network security.
  - Verification: canonical repeats succeed byte-identically; upper/parent symlink and ancestor/final replacement fail with exact receipts; a narrow post-hook tripwire for the actual implementation records zero root/absolute reopen; descriptor-stress loops repeat success and every named failure for both kinds and prove no cumulative handle growth on Darwin and Linux while preserving bytes, spawning no child, and reading no replacement bytes.
- [x] #171.B Normalize the bounded source record without changing parser limits.
  - In: source-record schema, canonical valid fixture, and direct public regression tests.
  - Verification: primary/witness independently reject a mismatched source digest, manifest digest, or count and reject reintroduced admitted arrays; 237 short entries are exactly 512 items and succeed, 238 are 514 items and return `CONTRACT_JSON_ITEM_LIMIT`, both below the byte limit; isolated node exact/+1 and option 1 remain unchanged.
- [x] #171.C Preserve the direct-input compatibility surface.
  - Verification: both public direct commands retain exit/stdout/stderr/LF receipts, canonical JSON and exact four-SHA equality including independent and synchronized strict-subset forgeries; focused tests, typecheck, strict OpenSpec, full repository check, no-write, scope, and submodule hygiene pass.

### Issue #175 retained-descriptor provenance overlay

This overlay is the active implementation fixture for #175, the first replacement
child of #172. Fixture level is `expanded`; repair intensity is `high`; upstream
suggestion is `expanded` (agree). The minimal mergeable slice is one production
descriptor-provenance allowlist plus the fd-0 and Linux `AT_FDCWD` mutations.

- [x] #175.A Bind raw descriptor operations to retained provenance.
  - In: `contracts/lib/capabilities.ts`, its existing `ingress.ts` issuance call sites, `contracts/tests/authority-descriptor-{vocabulary,preload}.ts`, `contracts/tests/authority-descriptor-{structural,runtime}.test.ts`, the spike-local `authority-descriptor-typeproof.{ts,test.ts}`, and `contracts/tsconfig.descriptor-authority.json` only.
  - Implement the design's opaque `CapabilityDescriptor` plus generation-bound private registry, one-way instance admission seal before `afterAdmission`, exact `pending_retained -> retained`, `verification`, and `closed` transitions, exact parent/phase/flag/kind/owner checks, and one pre-syscall `DescriptorAuthorityDenial` for every rejection.
  - Preserve the #171 compatibility crosswalk: exact direct receipts/opposite-stream emptiness, four-SHA binding, 237/238 capacity, no write/child/replacement read, close ordering/error precedence, and descriptor baseline on Darwin/Linux.
  - Out: Bun/Node/Worker/FFI/child delegate-equivalence topology (#176), Worker close/exit causality (#177), final receipt publication (#178), live Git, production runtime, workflows, scientific governance, and network security.
  - Verification: the design lifecycle matrix covers valid retained/verification operations plus foreign, raw-number, stale/closed/same-fd-reuse, invalid flag/kind/owner, `fstatSync`/`closeSync` negatives, sealed-root/invalid-relative/read guard-order rows, and exact issued/foreign receipt identity with exact events and zero raw calls.
- [x] #175.B Prove ambient descriptor mutations fail before side effects.
  - Structural-only: compile the full production tree with the literal `readSync(0, buffer, offset, length, null)` and `openAt()(-100, childCString("ambient-secret"), FILE_OPEN_FLAGS)` mutations from the design; reject with `raw_read_descriptor_not_handle` and `openat_parent_not_handle` without loading the active preload.
  - Active-only: disable structural scanning; fd-0 runs on Darwin/Linux with FIFO stdin whose connected writer remains open but sends no bytes, and completes in <=1 second; `AT_FDCWD` runs on Linux with an unread cwd sentinel. Each returns exit 2, empty stdout, the exact schema-invalid stderr receipt, exactly one named raw-denial event, zero target bytes, and zero open/read side effects.
- [x] #175.C Verify and hand off the bounded slice.
  - Verification: focused structural/runtime/direct tests plus the spike-local no-emit vocabulary proof, both public direct commands, typecheck, full `check`, strict OpenSpec, diff/scope/untracked/submodule hygiene, and Darwin/Linux Bun 1.2.19 receipts are green.
  - Handoff: #176 may consume only `CapabilityDescriptor`, `DescriptorCapabilityState`, `DescriptorOperation`, `DescriptorAuthorityDenial`, and immutable `DESCRIPTOR_OPERATION_POLICY` from `contracts/lib/capabilities.ts`; the registry stays private, `DescriptorIngressOperation` remains ingress-only, and #176 cannot broaden descriptor origin, flags, lifecycle, event fields, or public receipts.

### Issue #183 descriptor primitive mediation overlay

This overlay is the active implementation fixture for #183, the maintainer-approved
prerequisite inserted between #175 and #176 after PR #182's Round 3 depth retro.
Fixture level is `expanded`; repair intensity is `high`. The minimal mergeable
slice is one #175-owned, one-shot primitive mediation installer plus
process-isolated contract tests; #176 remains out of this PR.

- [x] #183.A Add the exact primitive mediation and cleanup-ownership seam.
  - In: `contracts/lib/capabilities.ts`, ingress-owned cleanup retry, and focused descriptor tests only. The sole new runtime export is `installDescriptorPrimitiveMediator`; the sole new type exports are `DescriptorPrimitiveInvocation = () => unknown` and `DescriptorPrimitiveMediator = (operation: DescriptorOperation, invoke: DescriptorPrimitiveInvocation) => unknown`. Keep the registry, descriptor records, `ContractCapabilities` implementation, raw callables, raw results, and any authority-enter/reset/getter/replacement path private.
  - The installer validates before its module-instance latch, is frozen and non-constructible, and exposes only its standard own data surface and `Function.prototype`. The mediator receives the exact `DescriptorOperation` plus a synchronous, callback-scoped, exactly-once closure only around `openSync`, an already-resolved `openat` callable, `fstatSync`, `readSync`, or `closeSync`; lazy `dlopen`/symbol resolution finishes before the callback. Callable metadata reflection is forbidden.
  - A normal mediator return expires the closure before any `then` getter or Proxy inspection while retaining callback/reentry state through classification. Only a raw invocation that began before return controls the API outcome. Omission/ordinary thenable/deferred use fails stable with zero raw calls.
  - A private nonexported retryable-close error classification identifies no-raw close failure. Root/child rollback, verification cleanup, retained final cleanup, and checker ingress retry only that result, through the mediator and at most twice total; raw-terminal close stays terminal. Persistent refusal is bounded, has no unmediated fallback, and preserves primary-over-cleanup precedence.
- [x] #183.B Prove the seam cannot grant ambient authority.
  - Process-isolated tests cover the five-operation return getter/Proxy matrix; frozen installer own/inherited descriptors and pre-freeze prototype mutation; constructor/tag/prototype/branding traps; invocation own-key, descriptor, prototype, symbol, and raw-result privacy across all five raw result kinds; exact frozen invalid-denial rows; every public-entry reentry in all five outer windows; and bounded ingress close settlement for transient and persistent refusal.
  - Binding-aware structural traversal resolves every `BindingName`, excludes aliases, requires the sole top-level mediation helper and resolved `openat` callable, and binds exact parent fd, NUL child bytes, flags, and issued-result relation. Destructured helper shadow, extra aliased call, wrong child argument, and wrong flags each make the proof red.
  - Exact runtime/type export allowlists, descriptor structural/runtime/typeproof tests, and both public direct receipts remain byte-identical except for the three explicitly named #183 exports.
- [x] #183.C Execute the causal verification and hand off the prerequisite.
  - Darwin dependency preparation is `npx --yes bun@1.2.19 install --frozen-lockfile`. At the fixed clean head, run `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests/*.test.ts` and `npx --yes bun@1.2.19 x tsc -p spikes/git-status-capability/contracts/tsconfig.descriptor-authority.json`.
  - For the final source-only red proof, retain the complete current focused tests while replacing only `spikes/git-status-capability/contracts/lib/capabilities.ts` with `e70a0853ae6b1d6a3fd80ffe92ca98d7926eede8`'s pre-seam source. Preserve the full red transcript, restore the exact fixed source immediately, prove `git diff --exit-code -- spikes/git-status-capability/contracts/lib/capabilities.ts` and an empty `git status --porcelain`, then rerun the focused suite and descriptor type proof green. No red/green receipt or count is claimed until the orchestrator executes this procedure.
  - Linux mounts the exact source read-only at `/repo` and frozen dependencies at sibling `/node_modules`, sets `NODE_PATH=/node_modules`, and runs the same complete contracts suite plus `/node_modules/typescript/bin/tsc -p spikes/git-status-capability/contracts/tsconfig.descriptor-authority.json`; it MUST NOT mount dependencies under `/repo/node_modules`.
  - After the repaired green receipt, run `npx --yes openspec validate m2-capability-observer-spike --strict --no-interactive`, `git diff --check`, `git diff --exit-code origin/main -- openspec/changes/m2-capability-observer-spike/design.md`, `git -C zero diff --quiet`, and require empty `git status --porcelain` plus no `red-proof` entry from `git stash list`.
  - Handoff: #176 may additionally import only runtime `installDescriptorPrimitiveMediator` and types `DescriptorPrimitiveInvocation` and `DescriptorPrimitiveMediator` with the exact signatures above. It must remove `ContractCapabilities` import/prototype rewriting and broad method-depth exemption; #176 still cannot access registry state or broaden descriptor origins, flags, lifecycle, events, or receipts.
  - Dependency: merged #175 -> #183 -> #176 -> #177 -> #178.



- [ ] 1.2 Implement the deterministic evidence validator and four-layer golden state machine.
  - PR boundary: pure evidence-to-validation library/CLI module; minimal mergeable slice consumes committed synthetic bundles and never runs Git, fixtures, or native code.
  - In: `spikes/git-status-capability/validator/**`, including the independently implemented `source-input-witness-v1`, and validator tests/fixtures only.
  - Out: command dispatcher, oracle generation, launcher/tripwires, observer, CI, final evidence.
  - Depends on: 1.1.
  - Verification: goldens cover all-pass accepted; unexpected semantic rejection rejected; exact expected negative and exact-bound pass; bound+1 right/wrong code; platform unsupported rejected; missing/duplicate/corrupt/oversized/stale/source-drift/repository/governance-gate failure invalid with no decision; the witness independently enumerates/frames live inputs and matches only the synthetic literal; raw versus RFC-8785 projection digests vary exactly as design D8 specifies.

- [ ] 1.3 Expose stable spike-only commands, repository gates, and the reusable atomic finalizer.
  - PR boundary: fixed command/finalizer/repository-gate source; minimal mergeable slice wires 1.1/1.2, independently implements `source-input-primary-v1`, implements every D9 spike-local gate command against disposable repositories, and proves publication mechanics with synthetic candidates without publishing live evidence.
  - In: `spikes/git-status-capability/verify.sh`, `spikes/git-status-capability/{cli,finalizer,repository-gate}/**`, public-seam finalizer/gate tests, and spike-local command documentation.
  - Out: fixture setup, observer launch, semantic implementation, workflow, and live evidence; for the finalizer seam specifically, only live candidate invocation/terminal publication is deferred to 5.4.
  - Depends on: 1.2.
  - Verification: primary and witness share no framing/enumeration code and cross-check live digest/set/manifest identity at runtime; contract/health/expect exits remain distinct; every D9 spike-local gate command is fixed and red/green tested with disposable clean/drift repositories but emits no live gate record; the fixed `evidence publish` finalizer proves destination-race no-clobber, cross-device rejection, overwrite refusal, partial-rename fault rollback, primary/cleanup failure precedence, absent final destination on failure, and no residue; expectation consumes only a staged candidate and is never a D9 input.

## 2. Independent fixture and oracle slices

- [ ] 2.1 Add pinned-Git oracle recipes for baseline, staging, and true-untracked rows.
  - PR boundary: oracle fixtures `BAS-001..006`, `STG-001..012`, and only `UNT-001`, `UNT-002`, `UNT-009`; minimal mergeable slice freezes these 21 literal expected outcomes and frames but cannot mark observer rows pass.
  - In: `spikes/git-status-capability/fixtures/{baseline,staging,true-untracked}/**` and their oracle modules used only before observation.
  - Out: ignore/exclude/global-control rows `UNT-003..008`, attributes/config, index/layout, attacks, launcher/tripwire, native semantics.
  - Depends on: 1.1.
  - Verification: Git `2.49.0` recipes reproduce all 21 exact outcomes twice across setup-order/root changes, freeze expected/frame/generation before attack, and never create an oracle for `UNT-003..008`.

- [ ] 2.2 Add pinned-Git oracle recipes for ignore, attributes, and effective config.
  - PR boundary: oracle fixtures `UNT-003..008`, `ATR-001..005`, `CFG-001..021`; minimal mergeable slice owns only these 32 rows and their literal expected outcomes.
  - In: `spikes/git-status-capability/fixtures/{ignore,attributes,config}/**` plus their oracle recipe modules.
  - Out: baseline/staging and true-untracked `UNT-001`, `UNT-002`, `UNT-009`; index/layout/nested, helpers, launcher, native comparison.
  - Depends on: 1.1.
  - Verification: all 32 rows cover ignored-only, root/nested ignore, `.git/info/exclude`, controlled/disabled global excludes, root/nested/`.git/info/attributes`, `core.attributesFile`, local/worktree/include config, autocrlf/eol, fileMode/ignoreCase/trustctime/checkStat/ignoreStat, boolean aliases and invalid token with no ambient user config; no `UNT-001`, `UNT-002`, or `UNT-009` recipe is owned here.

- [ ] 2.3 Add pinned-Git oracle recipes for index, layout, nested state, and #132 floor rows.
  - PR boundary: oracle fixtures `IDX-001..020`, `LAY-001..004`, `NES-001..013`; minimal mergeable slice owns these 37 exact frozen bytes/results, not observer support.
  - In: `spikes/git-status-capability/fixtures/{index,layout,nested}/**` and their oracle recipe modules.
  - Out: other fixture groups, launcher/tripwire, native parser/status code.
  - Depends on: 1.1.
  - Verification: all 37 rows cover v2/v4/split plus linked/nested split clean+dirty, separate stage-1/2/3 gitlink conflicts, unknown/malformed records, normal/gitfile/linked layouts, initialized/deinitialized/absent nested states, three post-audit drifts, and LF/U+2028/U+2029 recursion; each `F132-01..15` maps one-to-one to its row and exact Git/code oracle.

- [ ] 2.4 Add attack, helper, replay, and collection-protection fixture controls.
  - PR boundary: recipes/controls `CAP-001..017`, `HLP-001..017`, `PRT-001..012`; minimal mergeable slice owns these 46 rows and proves each external sentinel can fire but does not implement launcher policy or native handling.
  - In: `spikes/git-status-capability/fixtures/{capability,helpers,protection}/**` and isolated canary/control binaries or scripts.
  - Out: production roots, semantic fixtures, live launcher enforcement, observer code.
  - Depends on: 1.1.
  - Verification: foreign/stale/cross-row controls, replacement/deleted-open descriptor, main/linked/nested worktree-config clean and included-process filters, separate post-audit injection controls, separate main/nested fsmonitor, network sentinels, protected TMPDIR aliases, pre-creation, and mutation controls demonstrate exact oracles; each `F132-16..25` maps one-to-one to its row.

- [ ] 2.5 Add exact-limit, lifecycle, cleanup, and determinism fixture controls.
  - PR boundary: recipes/controls `LIM-001..026`, `LIF-001..008`, `DET-001..004`; minimal mergeable slice owns deterministic boundary inputs and expected codes only.
  - In: `spikes/git-status-capability/fixtures/{limits,lifecycle,determinism}/**` and their external limiter/fault controls.
  - Out: native enforcement, launcher settlement, CI, terminal evidence.
  - Depends on: 1.1.
  - Verification: each exact input is constructible on macOS/Linux, each +1 differs by the smallest declared unit, timeout/signal/cleanup/parallel controls fire, byte-identical repeat is legal, and volatile counter/order/root changes retain expected normalized results.

## 3. Launcher and active tripwire slices

- [ ] 3.1 Implement descriptor/frame launcher and replay boundary.
  - PR boundary: launcher transport and generic raw-evidence emitter only; minimal mergeable slice opens/validates one checkout, freezes schedule, supplies one frame, launches a stub observer, bounds/reaps it, and emits schema-valid launcher evidence without claiming semantics.
  - In: `spikes/git-status-capability/{launcher,evidence-emitter}/**` and launcher/emitter public-seam tests.
  - Out: protection-set tripwire implementation, native Rust transport, semantic status, CI.
  - Depends on: 1.1, 2.4, 2.5.
  - Verification: no-follow descriptor allowlist, minimal credential-free environment, no network, replacement/deleted-open attacks, stale/cross-row rejection, timeout/signal/reap, and no partial outcome all match catalog; observer receives only descriptor plus frame. The generic emitter rejects missing/duplicate/oversized/unbound receipts and can assemble a synthetic bounded platform bundle without Git semantics or a terminal decision.

- [ ] 3.2 Implement active transitive tripwires and collection-wide zero-write protection.
  - PR boundary: launcher-adjacent controls only; minimal mergeable slice wraps the exact stub invocation and makes every attack control from 2.4/2.5 bite.
  - In: `spikes/git-status-capability/tripwires/**`, protection-set inventory/event code, and transitive call-ledger tooling.
  - Out: native semantics, target CI, terminal evidence, production path helpers.
  - Depends on: 3.1, 2.4, 2.5.
  - Verification: whole-set pre/post plus event oracle covers superproject, four published checkouts, admitted checkout, nested roots and physical/symlink aliases for every invocation; controls catch `/proc/self/fd`, `/dev/fd`, discovery/reopen, process/network/helper use, create-delete/chmod/utime/index/lock/object writes, leak and over-limit output; unfaulted stub stays quiet.

## 4. Native observer slices

- [ ] 4.1 Implement native descriptor/frame transport and exact build ledger without semantic pass claims.
  - PR boundary: low-level Rust transport scaffold; minimal mergeable slice parses/binds frames, duplicates/fstats/fchdirs the descriptor, emits stable rejection/outcome framing, and settles resources against a trivial clean fixture.
  - In: `spikes/git-status-capability/native/src/{main,frame,descriptor,outcome,cleanup}.rs`, native unit tests, and exact-build call-ledger annotations.
  - Out: Git status semantics, high-level gix open/discovery, Git/libgit2/path fallback, CI/supply publication.
  - Depends on: 1.3, 3.2.
  - Verification: `--locked --frozen` build with task-1.1 graph; malformed/foreign descriptor/frame, byte-identical repeat, cleanup, and active ambient/process tripwires pass on each locally present supported OS; no semantic catalog row is reported decision-bearing.

- [ ] 4.2 Implement baseline, staging, and true-untracked comparison.
  - PR boundary: only `BAS-001..006`, `STG-001..012`, `UNT-001`, `UNT-002`, `UNT-009`; minimal mergeable slice adds low-level HEAD/index/worktree/untracked operations for these 21 rows.
  - In: `native/src/{baseline,staging,true_untracked}.rs` and focused public runner tests for those rows.
  - Out: ignore/exclude/global-control `UNT-003..008`, attributes/config, split-index, layout/nested, attacks, limits, CI.
  - Depends on: 1.2, 2.1, 3.2, 4.1.
  - Verification: all 21 rows match frozen Git-oracle outcomes on the current platform with catalog/validator/oracle/tripwire identities ready, deterministic output, whole protection-set zero-write, and no fallback; this slice cannot emit results for `UNT-003..008`.

- [ ] 4.3 Implement ignore, attribute, and effective-config comparison.
  - PR boundary: only `UNT-003..008`, `ATR-001..005`, `CFG-001..021`; minimal mergeable slice consumes frozen ignore/exclude/attribute/effective config for these 32 rows without ambient config reads.
  - In: `native/src/{ignore,attributes,config}.rs` and focused runner tests for those rows.
  - Out: baseline/staging and true-untracked `UNT-001`, `UNT-002`, `UNT-009`; index/layout/nested, helper execution, limits, CI.
  - Depends on: 1.2, 2.2, 3.2, 4.1.
  - Verification: all 32 exact outcomes/codes match on the current platform; host config and helpers remain unreachable; this slice cannot emit results for `UNT-001`, `UNT-002`, or `UNT-009`; unsupported semantic behavior is a row fail, never skip.

- [ ] 4.4 Implement index v2/v4 and split-index handling.
  - PR boundary: only `IDX-*`; minimal mergeable slice parses in-memory index/shared material, linked/nested split-index state, gitlink stages, and exact corruption/size errors.
  - In: `native/src/index/**` and focused runner tests for 20 rows.
  - Out: worktree layout/nested semantics, unrelated config, CI.
  - Depends on: 1.2, 2.3, 3.2, 4.1.
  - Verification: all 20 rows match exact outcomes/codes; linked/nested split clean+dirty remain distinct; stage 1/2/3 each reject `INDEX_GITLINK_CONFLICT`, unknown stage rejects `INDEX_STAGE_UNKNOWN`, malformed record rejects `INDEX_MALFORMED`, and none reaches status/helper execution.

- [ ] 4.5 Implement normal, gitfile, linked-worktree, and nested state handling.
  - PR boundary: only `LAY-*`, `NES-*`; minimal mergeable slice consumes payload-bound indirection/nested state, identity drift, and byte-exact gitlink paths in descriptor-relative worktrees.
  - In: `native/src/{layout,nested}.rs` and focused runner tests for `LAY-001..004`, `NES-001..010` (14 rows).
  - Out: attacks/helpers, limits/lifecycle, CI, production StackLock recursion.
  - Depends on: 1.2, 2.3, 3.2, 4.1, 4.4.
  - Verification: all 14 owned rows cover direct/recursive initialized clean/dirty, deinitialized clean, absent dirty, and absent→present/disappearance/same-path replacement as `NESTED_STATE_CHANGED`; the completed nested observer seam is ready for 4.6's helper controls.

- [ ] 4.6 Implement capability attacks, helper nonexecution, and replay outcomes.
  - PR boundary: only `NES-011..013`, `CAP-*`, `HLP-*`, `PRT-*`; minimal mergeable slice closes attack taxonomy and exact negative outcomes around the completed nested-capable binary.
  - In: `native/src/{safety,helpers}.rs`, launcher replay integration, and focused runner tests for 49 rows.
  - Out: semantic groups, resource limiter implementation, CI/final evidence.
  - Depends on: 1.2, 2.4, 3.2, 4.1, 4.2, 4.3, 4.5.
  - Verification: all 49 rows match exact outcomes; LF/U+2028/U+2029 recursion plus nested worktree-config, included-process, post-audit injection, and fsmonitor controls run on 4.5's observer rather than a stub/parent-only route; every control first fires, then the exact invocation stays helper/network/ambient-path/write free.

- [ ] 4.7 Implement exact limits, lifecycle, cleanup precedence, and determinism.
  - PR boundary: only `LIM-*`, `LIF-*`, `DET-*`; minimal mergeable slice adds limiter/settlement logic without new Git semantics.
  - In: `native/src/{limits,lifecycle}.rs`, launcher settlement integration, and focused runner tests for 38 rows.
  - Out: workflow, supply reporting, persistent evidence, terminal decision.
  - Depends on: 1.2, 2.5, 3.2, 4.1, 4.2, 4.6.
  - Verification: all exact bounds pass, all +1 rows return only paired codes, timeout/signals reap, primary/secondary cleanup ordering is exact, parallel baselines restore, and legitimate repeat/order/root/counter variation is deterministic.

## 5. Dual-platform evidence, repository gate, and handoff

- [ ] 5.1 Add isolated dual-platform CI and exact supply-chain capture.
  - PR boundary: final covered workflow/supply source plus source freeze only; minimal mergeable slice fixes the last covered bytes, freezes `SOURCE_SHA`, runs source/native checks on both platforms, and persists the immutable source record without deriving a terminal decision.
  - In: `.github/workflows/git-status-capability-spike.yml`, `spikes/git-status-capability/supply/**`, and target graph/SBOM/license tests.
  - Out: production CI/release, platform bundles, repository-gate record, terminal evidence, and every GitHub mutation/comment.
  - Depends on: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7.
  - Verification: after all workflow/supply source and the manifest are final, fixed `PLATFORM-SOURCE-INPUT` runs both independent encoders once and create-new writes the sole external record; fixed `PLATFORM-NATIVE` uses the same lock/source/direct features. Only after source/native observation closes, unchanged record bytes are persisted at `evidence/source/<digest>/source-input-record.json`; actual graphs, call ledger, SBOM, and license inventories are complete/digested. Failure leaves no source lane or later lane. No task after 5.1 changes covered source or repeats the live-digest field.

- [ ] 5.2 Produce complete bounded macOS/Linux raw bundles.
  - PR boundary: evidence invocation/cross-binding only; minimal mergeable slice invokes task 3.1's fixed emitter and persists two schema-valid raw bundles/manifests, with no source or terminal decision.
  - In: external bounded CI outputs plus `openspec/changes/m2-capability-observer-spike/evidence/platform/<source-input-digest>/**` containing only immutable JSON/Markdown or content-addressed references.
  - Out: evidence-emitter source, covered source/manifest changes, repository gate, final decision/summary, and every Issue #132/PR #133 write.
  - Depends on: 5.1.
  - Verification: fixed `PLATFORM-MATRIX` produces each of 174 IDs exactly once per OS and the exact 25-floor-ID bijection; only after both observations and collection-wide zero-write oracles close are the two bundles persisted in the platform lane. Both bind SHA-256 of the immutable source-input record without copying its live digest; all oracle/tripwire/protection/resource/cleanup/supply/command identities are present. Any mismatch/failure leaves no platform lane or later lane.

- [ ] 5.3 Run the post-matrix repository regression, isolation, and reproducibility gate.
  - PR boundary: pre-decision gate records only; minimal mergeable slice executes every D9 command against the evidence-bound source and emits `repository-gate.json`, with no candidate/terminal decision derivation, read, expectation, or publication.
  - In: invocation of task 1.3's fixed repository-gate commands plus `openspec/changes/m2-capability-observer-spike/evidence/gates/<source-input-digest>/**` bounded gate receipts only.
  - Out: repository-gate/covered source or manifest changes, fixes to production/tests/docs/submodules, decision publication, canonical docs, GitHub comments, and #132/#133 mutation.
  - Depends on: 5.2.
  - Verification: exact `GATE-SOURCE-INPUT` reruns both independent live encoders with `--no-write`, permits a committed literal only for the synthetic vector, and verifies task 5.1's immutable record plus record SHA-256; Bun `1.2.19`, docs, OpenSpec `1.3.1`, base/diff/scope/untracked/production/submodule gates and GET-only `GATE-GOVERNANCE` all record exact receipts. #132 must be OPEN/blocked, PR #133 merge `7d74a56eff27e34099961bdf14a40678c88d2603` reverted by main ancestor `2bf3ef8859278dd0817100c01775765612170648`, and GitHub mutation count zero. Only after every D9 gate passes may the non-decision-bearing gates lane persist; any mismatch/failure is invalid/no decision and leaves no gates lane or final lane.

- [ ] 5.4 Derive a candidate, assert it, then atomically persist the only terminal decision/handoff.
  - PR boundary: D10 invocation/evidence only; minimal mergeable slice validates 5.2/5.3, invokes task 1.3's already source-digested finalizer, derives a candidate under external same-filesystem staging, asserts it, repeats the read-only governance check, and publishes only after success; it owns no finalizer source.
  - In: external harness-owned staging plus `openspec/changes/m2-capability-observer-spike/evidence/final/<source-input-digest>/**`, unchanged `evidence/source/<source-input-digest>/source-input-record.json`, staged candidate/summary, `publication-assertion.json`, and `publication-governance-recheck.json`.
  - Out: `verify.sh`, `cli/**`, `finalizer/**`, production integration, canonical docs, every GitHub mutation/comment, closing #132, restoring/merging #133, or promotion.
  - Depends on: 1.3, 5.3.
  - Verification: candidate health, matching expect, governance recheck, unchanged source record, and fixed `FINALIZE-PUBLISH` precede one same-filesystem atomic no-replace rename; destination race, cross-device, overwrite, partial rename, digest/source-record/governance drift, or cleanup failure is invalid/CI red with no published terminal. Both accepted and rejected summaries persist #132 OPEN/blocked, #133 reverted, zero GitHub mutation, no production integration, and the unconditional requirement for a separate reviewed OpenSpec+ADR plus explicit human approval before any integration/close/merge/comment/promotion.
