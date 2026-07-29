# Round 5 final comprehensive review synthesis

Reviewed head: `0b832a825af9b352ccbb659c459f1acccf4c8618`
Mode: hybrid PR/OpenSpec review
Risk: high
Result: not clean; round ceiling terminal lock

Reviewer coverage: correctness, integration, local path/resource safety,
test/evidence, spec compliance, invariant/compatibility, and a fresh gap sweep.
Correctness, path/resource, and spec-compliance lenses returned clean. The other
lenses produced four deduplicated candidates, all independently adjudicated.

## Verified findings

### `r5-design-01` — P1 `design-consistency`

Verdict: CONFIRMED / FIX_NOW / blocking.

The approved ownership split assigns live manifest enumeration, synchronization,
and exact Git equality to Task 1.1c/#166, while stale canonical passages in
`spec.md:354-366` and `design.md:447-460` still assign them to Task 1.1a,
forbid future declarations, and require per-HEAD exact equality. Current tests
correctly accept canonical future declarations. The OpenSpec has two mutually
exclusive ownership contracts.

Required closure: align only the stale passages to the approved split; do not
restore #166 implementation. Strict validation plus a semantic ownership audit
must show 1.1a owns declaration syntax/initial committed oracle while 1.1c owns
live enumeration/sync/equality.

### `r5-path-01` — P1 `path-safety`

Verdict: CONFIRMED / FIX_NOW / blocking.

Issue #164 requires descriptor-bound authority after admission with no ambient
pathname reopen/discovery. `assertDescriptorPathUnchanged()` closes admission
ancestors, then reopens `/` and the full absolute path after the admission hook
and again after reading. It therefore violates the explicit capability boundary
across both direct input kinds and the four current-oracle reads even though it
fails closed on tested replacement.

Required closure: retain the necessary ancestor/parent capabilities and perform
all post-admission checks relative to them; prove with an open/syscall tripwire
that no root/absolute-path reopen occurs, retain replacement rejection, and show
descriptor cleanup on all paths.

### `r5-evidence-01` — P1 `test-evidence`

Verdict: CONFIRMED / FIX_NOW / blocking.

The 58-byte prefix frame plus recomputed sidecar and same-length mutated frame
plus recomputed sidecar are tested only through `validateSyntheticOracle`.
The required public `--check-current` seam has only independent frame or sidecar
mutations, so a mutual-consistency-only public wiring regression could succeed.

Required closure: add both synchronized pairs at the public seam with exit 2,
empty stdout, exact LF error receipt, no-write/no-child proof, plus a mutation
that weakens frozen-literal binding while preserving mutual digest consistency.

### `r5-compat-01` — P1 `compatibility`

Verdict: PLAUSIBLE / FIX_NOW / blocking under the high-risk expanded fixture.

The frozen profile permits 512 items, while a schema-valid source record uses
`42 + 6n` items because path/mode sets are repeated in top-level, primary, and
witness results. Independent replay proves 78 entries/510 items succeeds and
79 entries/516 items returns `CONTRACT_JSON_ITEM_LIMIT`, both far below the byte
limit. The current manifest has 27 entries and OpenSpec lacks a closed final-file
lower bound, so inevitability is not confirmed; however 79 entries is a real
schema input and the later DAG expands the covered manifest.

Required closure: establish an auditable planned manifest capacity bound before
freezing the record shape/profile; if it can reach 79, make the bounded shape or
profile sufficient while preserving primary/witness equality evidence.

## Gate outcome

Round 5 is recorded not clean with four blocking verified findings and highest
severity `major`. `review_gate.py` returned exit 2 and locked the ordinary loop
with `round-ceiling`. No further fix, comprehensive review, Phase 7, CI wait, or
merge action is permitted in this PR. The remaining choices are a PR split,
explicit descope, or stop/abandon, selected by the user. No terminal outcome is
recorded until that decision is made.
