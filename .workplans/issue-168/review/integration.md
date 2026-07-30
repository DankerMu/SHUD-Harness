# Review: PR #170 integration (Round 1)

Reviewed head: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Base: `origin/main` at `f8b74e724dc978acb889f715a936feabfd69680d`
Scope: `origin/main...HEAD`, Issue #168, PR #170 body/evidence, full `m2-capability-observer-spike` overlay/spec/tasks, and the #169 dependency contract.

## Summary

Split A is structurally independent of main and exposes a usable shared dependency surface for #169: descriptor-bound file ingress is centralized in `readBoundedFile`, semantic validation is centralized in `schemas.ts`, and the public CLI remains limited to the two direct kinds. The retained chain, normalized one-set record, tuple binding, ordering, exact receipts, and four-SHA contract are implemented coherently.

Two P1 evidence gaps remain. The claimed syscall tripwire observes only operations that the implementation voluntarily reports, and the required Linux descriptor-stress suite is not invoked by the repository's Linux CI command. These leave the governing path-authority and cross-platform cleanup invariants unproven at the reviewed SHA.

## Findings

### P1: The post-admission “tripwire” cannot observe uninstrumented filesystem opens

- Severity: P1
- Failure class: `test-evidence`
- Violated invariant/contract: Issue #168 requires an open/syscall tripwire proving zero root or ambient absolute-path reopen after admission; the OpenSpec contract requires no such reopen after the admission hook (`openspec/changes/m2-capability-observer-spike/specs/git-status-capability-spike/spec.md:187-207`).
- Evidence: `spikes/git-status-capability/contracts/tests/source-ingress.test.ts:131-153` asserts only the `DescriptorOperation[]` supplied by the implementation. Those events exist solely at explicit `observe?.(...)` call sites in `spikes/git-status-capability/contracts/lib/ingress.ts:117`, `:136`, `:169`, and `:351`; the observer does not intercept `openSync`, `openat`, or transitive filesystem calls. The task nevertheless marks #168.A complete on the strength of “post-hook open tracing” at `openspec/changes/m2-capability-observer-spike/tasks.md:32-35`.
- Concrete scenario: A later refactor, or a #169 committed-oracle helper consuming this seam, calls `openSync(admission.logicalAbsolutePath, ...)` after admission without first invoking `hooks.observe`. The current tripwire still sees only the reported relative operations and passes, even though ambient pathname authority has been reintroduced.
- Consequence: The key safety regression that motivated #168 can recur while the mandatory regression remains green; #169 would then build committed-oracle reads on a falsely certified capability boundary.
- Fix direction: Add an active, deterministic interception boundary around actual open syscalls/APIs used during the post-admission phase (or an equivalent sandbox/syscall audit) that fails on any root/absolute open independently of voluntary observer calls. Keep `DescriptorOperationObserver` only as diagnostic evidence, not the enforcement oracle.
- Required test/proof: Demonstrate a source-only mutant that performs an unreported post-admission absolute/root reopen and show the public test fails; restore source and show both direct kinds pass the active tripwire with exact receipts on Darwin and Linux.
- Sibling surfaces: `readBoundedFile` consumers added by #169 (`current-source.ts` manifest/metadata/frame/sidecar reads); any future wrapper around `openAt` or `openSync`.
- Blocking: yes.

### P1: Linux CI does not execute the required descriptor-stress matrix

- Severity: P1
- Failure class: `test-evidence`
- Violated invariant/contract: Repeated success and every named failure for both direct kinds must prove no cumulative descriptor growth on Darwin and Linux (`openspec/changes/m2-capability-observer-spike/specs/git-status-capability-spike/spec.md:187-194`; `openspec/changes/m2-capability-observer-spike/tasks.md:32-35`). The implementation evidence itself says Linux CI is required before merge (`.workplans/issue-168/implementation-evidence.md:39-40`).
- Evidence: The only Linux PR job runs `bun run check` (`.github/workflows/ci.yml:32-62`). That script enumerates production suites but never `spikes/git-status-capability/contracts/tests` (`package.json:11-29`). The focused suite is therefore absent from Linux CI even when `linux-base` is green.
- Concrete scenario: The Darwin run passes, but the Linux `dlopen("libc.so.6")`, `openat`, `/proc/self/fd` descriptor counting, or cleanup behavior fails. PR CI remains green because it runs typecheck and unrelated unit suites without executing any of the 19 contract tests.
- Consequence: Split A can merge without the mandatory Linux proof, and #169 can consume a platform-broken ingress dependency despite both-platform parity being a merge contract.
- Fix direction: Wire the exact pinned focused command into a required Ubuntu PR check, or otherwise provide immutable CI evidence at this exact SHA. Because the current #168 overlay declares workflows out of scope, reconcile that boundary explicitly rather than marking #168.A complete while the required proof is unreachable.
- Required test/proof: A required Linux job at `89eb2aad7895d837617d243a8ce82e3cdc45b211` must run `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests` and report all descriptor replacement/cleanup cases passing; the job log must show the focused suite, not only `bun run check`.
- Sibling surfaces: macOS CI wiring if local Darwin evidence is later replaced by CI; #169's expanded suite, which inherits the same native ingress implementation.
- Blocking: yes.

## Invariant Matrix Coverage

| Invariant / boundary | Coverage result | Evidence |
|---|---|---|
| Fixture bytes -> retained read -> bounded parser -> schema -> public receipt | Covered | `checker.ts:34-44`; focused tests pass 19/19, 458 assertions. |
| Retained capability chain after admission | Implementation covered; proof incomplete | `ingress.ts:110-193`, `:336-369`; active-tripwire finding above. |
| Setup ordering: admit -> hook/attack -> revalidate -> size/read -> revalidate -> cleanup | Covered | `ingress.ts:341-368`; ancestor/final replacement tests at `source-ingress.test.ts:40-88`. |
| Deterministic cleanup on success and named failure paths | Darwin covered; Linux unverified | `closeAll` at `ingress.ts:94-104`; stress tests at `source-ingress.test.ts:167-205`; Linux finding above. |
| One top-level admitted path/mode set | Covered | `schemas.ts:33-49`, `:66-86`; fixture/result-shape tests at `source-ingress.test.ts:209-243`. |
| Producer/result identity binding | Covered at the declared record contract | Both primary and witness tuples must equal top-level digest/digest/count at `schemas.ts:71-86`; independent mismatch tests pass. |
| Frozen item/node/byte profile | Covered for the #168 capacity contract | `constants.ts:1`; 237/238, node exact/+1, and exact byte tests at `source-ingress.test.ts:245-265`, `:312-321`. |
| Direct-kind compatibility and four-SHA identity | Covered | CLI accepts only the two kinds at `checker.ts:10-27`; exact receipt and all strict-subset SHA mutation tests pass. |
| #169 dependency surface | Covered | `readBoundedFile`, `DescriptorIngressHooks`, `ContractError`, and direct CLI/schema types are exported; no current-oracle, live Git, publication, runtime, workflow, or network implementation is present. |
| Independent mergeability from main | Covered subject to findings | The diff adds the complete direct ingress slice without importing absent #169 code; focused tests, typecheck, strict OpenSpec, and full repository `check` pass locally. |

## Mandatory cross-cutting lenses

### Removed-behavior audit

`git diff --numstat origin/main...HEAD` shows zero deleted lines and `git diff --diff-filter=D` is empty. Main had no committed contract checker to regress. The future-owned `--check-current` shape is deliberately rejected (`source-ingress.test.ts:323-330`) rather than partially implemented, so no removed main behavior was found.

### Altitude / ownership

The implementation is at the correct ownership layers: descriptor authority and cleanup live in the shared ingress helper, record invariants live in the central schema validator, and the CLI only parses/dispatches and formats receipts. Split A does not absorb #169, #166, #162, runtime, workflow, or network semantics. No altitude finding.

## Overall verdict

Blocking findings present. The implementation shape is suitable as Split A and as a dependency for #169, but merge readiness is not established until the active reopen proof and exact-SHA Linux descriptor-stress evidence exist. Final adjudication belongs to the downstream verifier/orchestrator.

## Verification performed

- `npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests` — pass: 19 tests, 458 assertions.
- `npx --yes bun@1.2.19 run typecheck` — pass.
- `npx --yes bun@1.2.19 run check` — pass; this command does not include the new focused suite.
- `npx --yes @fission-ai/openspec@1.3.1 validate m2-capability-observer-spike --strict --no-interactive` — valid.
- `git diff --check origin/main...HEAD` — pass.
- PR/head/base identity and Issue #168/#169 contracts inspected via read-only GitHub queries.

## Verification gaps

- No Linux execution of the focused suite was available at the reviewed SHA.
- No active syscall/API interception evidence proves that unreported post-admission opens are caught.
- The closed PR #167 implementation was used only to inspect the expected #169 consumer shape; #169 has not yet supplied mergeable code to compile against this branch.

## Residual risks

- `openat` is loaded through platform-specific Bun FFI (`libSystem` on Darwin, `libc.so.6` on Linux). The implementation is intentionally limited to those platforms; the missing Linux focused run is the material unresolved compatibility risk.
- Concurrent in-place mutation of an already-admitted inode is not covered by the named replacement contract. No finding is raised because #168 specifies ancestor/final pathname replacement, not immutable file contents against an already-authorized writer.

## Non-blocking notes

None.

## Out-of-scope escalations

None.

Execution Summary: agents=1; skills=none; tools=git, gh, rg, bun, tsc, OpenSpec; verification=focused tests/typecheck/full check/strict OpenSpec/diff checks passed; limits=no Linux focused execution and no active syscall tripwire proof.
