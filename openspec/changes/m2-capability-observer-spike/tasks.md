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

## 1. Frozen contract and validator

- [ ] 1.1 Freeze catalog v1, schemas, rejection taxonomy, limits, and dependency contract.
  - PR boundary: contract only; minimal mergeable slice is strict schema/catalog parsing plus golden valid/invalid fixtures, with no launcher or observer.
  - In: `spikes/git-status-capability/contracts/**` including `source-input-v1.paths`, the synthetic-only `goldens/source-input-v1.synthetic.{frame,sha256}`, `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, and `dependency-graph-catalog.json`; exact 174 IDs/outcomes, exact 25-floor-ID bijection, exhaustive fixture/native ownership maps, four-layer state schema, exact `source_input_digest_v1` frame/record, frame/evidence/bundle/decision schemas, Rust `1.88.0`, Git `2.49.0`, direct crates/features, target graph predicates, and all finite limits.
  - Out: validator decisions, fixture recipes, process launch, native source, CI, raw evidence, production paths.
  - Depends on: none.
  - Verification: manifest exact-set test rejects missing/extra/duplicate/skip/platform-conditional rows, any floor-ID merge/gap, and any fixture/native ownership overlap or gap; the only committed digest literal is for the fixed synthetic frame, never the live manifest; strict source-record/schema tests reject unknown/duplicate/missing fields, unsafe paths, exact evidence size + 1, and floating dependency sources; exact observer limits remain inclusive.

- [ ] 1.2 Implement the deterministic evidence validator and four-layer golden state machine.
  - PR boundary: pure evidence-to-validation library/CLI module; minimal mergeable slice consumes committed synthetic bundles and never runs Git, fixtures, or native code.
  - In: `spikes/git-status-capability/validator/**`, including the independently implemented `source-input-witness-v1`, and validator tests/fixtures only.
  - Out: command dispatcher, oracle generation, launcher/tripwires, observer, CI, final evidence.
  - Depends on: 1.1.
  - Verification: goldens cover all-pass accepted; unexpected semantic rejection rejected; exact expected negative and exact-bound pass; bound+1 right/wrong code; platform unsupported rejected; missing/duplicate/corrupt/oversized/stale/source-drift/repository/governance-gate failure invalid with no decision; the witness independently enumerates/frames live inputs and matches only the synthetic literal; raw versus RFC-8785 projection digests vary exactly as design D8 specifies.

- [ ] 1.3 Expose stable spike-only commands and the reusable atomic finalizer.
  - PR boundary: command/finalizer seam; minimal mergeable slice wires 1.1/1.2, independently implements `source-input-primary-v1`, and proves publication mechanics with synthetic candidates without publishing live evidence.
  - In: `spikes/git-status-capability/verify.sh`, `spikes/git-status-capability/{cli,finalizer}/**`, public-seam finalizer tests, and spike-local command documentation.
  - Out: fixture setup, observer launch, semantic implementation, workflow, and live evidence; for the finalizer seam specifically, only live candidate invocation/terminal publication is deferred to 5.4.
  - Depends on: 1.2.
  - Verification: primary and witness share no framing/enumeration code and cross-check live digest/set/manifest identity at runtime; contract/health/expect exits remain distinct; the fixed `evidence publish` finalizer proves destination-race no-clobber, cross-device rejection, overwrite refusal, partial-rename fault rollback, primary/cleanup failure precedence, absent final destination on failure, and no residue; expectation consumes only a staged candidate and is never a D9 input.

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
  - PR boundary: launcher transport only; minimal mergeable slice opens/validates one checkout, freezes schedule, supplies one frame, launches a stub observer, bounds/reaps it, and emits launcher evidence.
  - In: `spikes/git-status-capability/launcher/**` and launcher public-seam tests.
  - Out: protection-set tripwire implementation, native Rust transport, semantic status, CI.
  - Depends on: 1.1, 2.4, 2.5.
  - Verification: no-follow descriptor allowlist, minimal credential-free environment, no network, replacement/deleted-open attacks, stale/cross-row rejection, timeout/signal/reap, and no partial outcome all match catalog; observer receives only descriptor plus frame.

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
  - PR boundary: workflow/supply only; minimal mergeable slice runs already-complete matrix on macOS and Linux and records actual build inventories, without deriving a terminal decision.
  - In: `.github/workflows/git-status-capability-spike.yml`, `spikes/git-status-capability/supply/**`, and target graph/SBOM/license tests.
  - Out: production CI/release, final evidence persistence, repository-gate decision, and every GitHub mutation/comment.
  - Depends on: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7.
  - Verification: after fixing `SOURCE_SHA`, fixed `PLATFORM-SOURCE-INPUT` runs both independent encoders once and create-new writes the sole external `source-input-record.json`; no other artifact repeats its live-digest field. Fixed `PLATFORM-NATIVE` then runs with that record identity and the same lock/source/direct features; actual graphs, call ledger, SBOM, and license inventories are complete/digested.

- [ ] 5.2 Produce complete bounded macOS/Linux raw bundles.
  - PR boundary: evidence emission/cross-binding only; minimal mergeable slice produces two schema-valid raw bundles and bundle manifests, but still no terminal decision.
  - In: spike evidence-emitter modules and CI outputs under bounded temporary artifact paths.
  - Out: repository gate, committed final bundle/reference, decision/summary, and every Issue #132/PR #133 write.
  - Depends on: 5.1.
  - Verification: fixed `PLATFORM-MATRIX` produces each of 174 IDs exactly once per OS and the exact 25-floor-ID bijection; both bundles bind SHA-256 of the immutable source-input record without copying its live digest; all oracle/tripwire/protection/resource/cleanup/supply/command identities are present and any source/input mismatch invalidates both.

- [ ] 5.3 Run the post-matrix repository regression, isolation, and reproducibility gate.
  - PR boundary: pre-decision gate records only; minimal mergeable slice executes every D9 command against the evidence-bound source and emits `repository-gate.json`, with no candidate/terminal decision derivation, read, expectation, or publication.
  - In: spike-local repository gate implementation and bounded gate evidence.
  - Out: fixes to production/tests/docs/submodules, decision publication, canonical docs, GitHub comments, and #132/#133 mutation.
  - Depends on: 5.2.
  - Verification: exact `GATE-SOURCE-INPUT` reruns both independent live encoders with `--no-write`, permits a committed literal only for the synthetic vector, and verifies task 5.1's immutable record plus record SHA-256; Bun `1.2.19`, docs, OpenSpec `1.3.1`, base/diff/scope/untracked/production/submodule gates and GET-only `GATE-GOVERNANCE` all record exact receipts. #132 must be OPEN/blocked, PR #133 merge `7d74a56eff27e34099961bdf14a40678c88d2603` reverted by main ancestor `2bf3ef8859278dd0817100c01775765612170648`, and GitHub mutation count zero; any mismatch/failure is invalid/no decision.

- [ ] 5.4 Derive a candidate, assert it, then atomically persist the only terminal decision/handoff.
  - PR boundary: D10 invocation/evidence only; minimal mergeable slice validates 5.2/5.3, invokes task 1.3's already source-digested finalizer, derives a candidate under external same-filesystem staging, asserts it, repeats the read-only governance check, and publishes only after success; it owns no finalizer source.
  - In: external harness-owned staging plus `openspec/changes/m2-capability-observer-spike/evidence/final/<source-input-digest>/**`, unchanged external `source-input-record.json`, staged candidate/summary, `publication-assertion.json`, and `publication-governance-recheck.json`.
  - Out: `verify.sh`, `cli/**`, `finalizer/**`, production integration, canonical docs, every GitHub mutation/comment, closing #132, restoring/merging #133, or promotion.
  - Depends on: 1.3, 5.3.
  - Verification: candidate health, matching expect, governance recheck, unchanged source record, and fixed `FINALIZE-PUBLISH` precede one same-filesystem atomic no-replace rename; destination race, cross-device, overwrite, partial rename, digest/source-record/governance drift, or cleanup failure is invalid/CI red with no published terminal. Both accepted and rejected summaries persist #132 OPEN/blocked, #133 reverted, zero GitHub mutation, no production integration, and the unconditional requirement for a separate reviewed OpenSpec+ADR plus explicit human approval before any integration/close/merge/comment/promotion.
