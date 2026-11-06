# Design

## Context

As of `c99dd6ec`, rendered AGENTS.md is 317 lines and 56177 bytes. The `## Runtime Lifecycle` section of `instructions/agents/shared.md` is 44 non-blank lines and 32118 bytes, about 81 lines counting blanks.

`scripts/instructions/check-line-budget.py` reads exactly one `thresholds.agents_md_max_lines` with stdlib regex and is invoked by `render.sh --check`. The existing real-render self-test runs from `test-guardrails` and from CI docs-gate. `doc_gate.path_claim_files` lists the files whose backticked repo paths `docs:paths` verifies.

## Goals / Non-Goals

Governing invariant: reducing the hot path changes where rules live, never their authority or their text.

Must preserve:
- every Runtime Lifecycle sentence: root kernel plus cold doc, in original relative order;
- path-claim gating for the relocated text;
- the 320-line limit and its exact semantics;
- byte-drift checking for both projections;
- the absence of a CLAUDE.md budget;
- fail-closed configuration.

Non-goals:
- rewording, summarising or deduplicating the relocated contract;
- touching project-profile's overlapping API notes;
- any runtime, product, host or eng-init skill change.

## Decisions

**What stays in the root.** The root keeps lines verbatim, never paraphrased:
- the intro and the first launch block;
- the safe-recovery paragraph, which holds the operator forbidden moves on `.lock-guard`, `active.json` and `completed.json`;
- the Web/headless start paragraph and its block;
- the deployment/evidence paragraph;
- one mandatory pointer, written as "must read and comply before changing `packages/dsh-shud-jobs/`, `packages/dsh-shud-presets/`, `scripts/runtime/`, `profile/` or the installer". The pointer meets the existing "mandatory referenced canonical documentation" clause. A restated summary would create a second home for the same facts.

**The cold document.** `docs/04_IMPLEMENTATION/Runtime_Lifecycle.md` gets `status: living` and `canonical_for: [runtime-lifecycle]`. Its short header points back to the root kernel, and the remaining 30 lines follow in original order. "Lossless" means text-identical modulo link-path rebasing; the inventory is:
- `docs/03_SPEC/Park_Resume_Design.md#…` becomes `../03_SPEC/…` (3 links);
- `../../docs/04_IMPLEMENTATION/Repository_Layout.md#…` becomes `Repository_Layout.md#…` (1 link).

Backticked root-relative path claims are unaffected, because `check_paths.py` resolves them from the repo root.

**The byte budget.** Extend the existing checker rather than adding a second one:
- It reads both keys under the same single-thresholds-block, single-entry, positive-decimal rules.
- Missing, duplicate or malformed values for either key fail with exit 2 ("invalid budget configuration"), and the renderer reports that as 1.
- The byte count is the raw length of `AGENTS.md`.
- Each exceeded budget prints a diagnostic that names the unit, the measured value, the limit and the key.

**Self-tests.**
- Existing fixtures now carry both keys. Line cases use an unbounded byte limit, so they still test lines alone.
- Invalid-config cases pair one bad key with one valid key, so each rejection is attributable.
- New byte cases build the target size through the public render seam. They cover exactly at the limit (accepted), one byte over (rejected), CLAUDE-only excess (accepted), and a configured limit of 2000 to show the value is not hard-coded.

**The limit.** 29000 = ceil(26191 × 1.1 / 1000) × 1000. The constraints comment records the measurement.

## Required Evidence

- A RED run of the new self-test against the HEAD checker. Only byte cases fail; all line cases pass.
- GREEN after the change.
- The scratchpad relocation oracle: original section == kernel + doc after undoing the 4 rebased links, with 0 missing and 0 extra lines.
- `pnpm run instructions:check`, `docs:check`, `test-guardrails` and `check` all green.
- `openspec validate instruction-hot-path-budget --strict` passes.

## Risks / Rollback

- **[Relocated rules read as optional]** Mitigated by the root pointer's mandatory wording, matching the Enforcement Index precedent.
- **[Relocated path claims stop being gated]** Mitigated by adding the new document to `doc_gate.path_claim_files`.
- **[Byte budget silently skipped]** Mitigated because both keys are required, and missing configuration fails instead of defaulting.

Rolling back is a normal revert plus re-render; there is no runtime migration.
