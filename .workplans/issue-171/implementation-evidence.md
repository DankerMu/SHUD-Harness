# Issue #171 implementation evidence

Branch: `codex/issue-171-core-source-ingress`
Base: `origin/main` at `322e0e8881e695c02f9fda6910934ba287811563`
OpenSpec: `m2-capability-observer-spike`; fixture `expanded`; repair `high`
Fixture review: pass; `.workplans/issue-171/fixture-review.md`

## Scope delivered

- Retained root/directory/final-file capabilities for the two direct input kinds.
- Descriptor-relative post-admission revalidation/read and deterministic cleanup.
- One top-level admitted path/mode set with digest/count-bound primary/witness.
- Exact direct receipts, canonical JSON, four-SHA binding, option-1 limits.
- Narrow actual-implementation post-hook tripwire; no authority preload/AST lane.

## Red proof

`.workplans/issue-171/red-proof.md` records the batched pre-source command:

`npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests/source-ingress.test.ts spikes/git-status-capability/contracts/tests/source-identity.test.ts`

Result on base source: exit 1; 0 pass / 2 fail because the new checker and
canonical-json modules did not yet exist. Tests and fixtures were present before
any `contracts/check.ts` or `contracts/lib/**` implementation file.

## Green verification

- Darwin focused contracts: 24 pass / 0 fail / 513 assertions.
- Linux Bun 1.2.19 read-only container: 24 pass / 0 fail / 465 assertions.
- Darwin and Linux direct `source_input_record` command: exact success receipt.
- Darwin and Linux direct `source_identity_projection` command: exact success receipt.
- `npx --yes bun@1.2.19 run typecheck`: pass after initializing pinned `zero` and installing the frozen workspace.
- `npx --yes bun@1.2.19 run check`: pass.
- strict OpenSpec validation: valid.
- `git diff --check`: clean; stash empty; `zero` pinned at `13e25c1`.

## Exact capacity

- 237 short entries: 512 counted items, 5,100 serialized bytes, exit 0.
- 238 short entries: 514 counted items, 5,116 serialized bytes, exit 2 with only `CONTRACT_JSON_ITEM_LIMIT`.
- Source profile remains 65,536 bytes / depth 12 / nodes 2,048 / items 512.
- With item ceiling independently relaxed, 2,048 nodes parse and 2,049 returns `CONTRACT_JSON_NODE_LIMIT`.

## Boundary audit

- Producers: canonical direct-input fixture bytes only; no writes.
- Validators: retained no-follow capability chain and normalized tuple equality.
- Public entrypoints: only `source_input_record` and `source_identity_projection`.
- Failure/cleanup: success, symlink, replacement, malformed, schema, bound, hook,
  and close-fault paths settle descriptors and emit stable receipts.
- Compatibility: canonical JSON, exact four-SHA equality, parser option 1, and
  direct receipt bytes retained.
- Excluded siblings: #172 preload/AST/hostile-source proof and historical evidence;
  #169 committed-current behavior; #166/#162; runtime/workflow/network security.

Plan deviation: none.
