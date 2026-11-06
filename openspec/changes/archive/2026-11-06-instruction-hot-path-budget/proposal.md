# Instruction hot-path budget

## Why

Both root instruction files load in full on every agent session, and each was about 56 KB on 2026-11-06. Runtime Lifecycle took 32 KB of that (58%), almost all of it the internal shud-jobs contract for locks, submission, settlement, cancellation, collection, wake and takeover. The 320-line budget passed only because single lines reached about 2 KB, so counting lines cannot stop the root from growing. The current engineering-gates requirement also says source consolidation must not change Runtime Lifecycle content, which rules out relocating it without a spec change. The PI chose to relocate it to a cold document, keep a hot kernel in the root, and add a byte budget, keeping the strictness profile at L3.

## What Changes

- Move the Runtime Lifecycle paragraphs that are not operator-hot, verbatim, into `docs/04_IMPLEMENTATION/Runtime_Lifecycle.md`, which becomes their only home. Only link paths are rebased: 3 Park_Resume_Design links and 1 Repository_Layout link.
- The root keeps, verbatim:
  - the two launch blocks;
  - the safe-recovery forbidden-moves paragraph;
  - the Web/headless start paragraph;
  - the deployment/evidence paragraph;
  - a mandatory-read pointer written like the existing Enforcement Index pointer.
- Add the new document to `doc_gate.path_claim_files`, so its backticked repo paths stay gated.
- Read `thresholds.agents_md_max_bytes` from constraints.yaml and reject a rendered AGENTS.md larger than it. The value is 29000: the 26191 bytes measured after the move plus 10%, rounded up. Configuration is fail-closed exactly like the line budget. The 320-line budget is unchanged, and CLAUDE.md still has no budget.
- Fact refresh: compress the closed M3/M4 Epic acceptance clauses into one ADR pointer line, change the pinned vitest version to 5.1.0, and rewrite the constraints `schema_version` from the legacy `3.6.1` to schema `1`.

## Capabilities

### Modified Capabilities
- `engineering-gates`: a lossless relocation contract replaces the consolidation rule that Runtime Lifecycle must not change, and a rendered byte budget joins the default instruction check.

## Impact

- **Files changed:** the canonical shared instruction source and both generated projections, one new implementation document, constraints thresholds and the doc gate list, the budget checker and its real-render self-test, and the Testing_Strategy budget description.
- **Not changed:** product code, host, runtime behaviour, scientific or PI rules, and gate relaxations.

## Risk triage

- **Issue type:** governance / tooling hardening.
- **Fixture level:** expanded.
- **Blast radius:** rules that silently become optional or are lost during the move, or a default documentation gate that gives false positives or false negatives.
- **Selected risk packs:** Public CLI; Config; File IO; Error handling; Documentation.
- **Evidence floor:**
  - a lossless relocation oracle;
  - RED against the old checker, then GREEN;
  - byte at-limit/+1/CLAUDE-only/config-sourced/invalid-config cases;
  - unchanged line cases;
  - default docs/full check, guardrails, and `--strict` validation.
