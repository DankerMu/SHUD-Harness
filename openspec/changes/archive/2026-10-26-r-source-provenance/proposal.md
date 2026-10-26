# Proposal

## Why

Issue #391 identifies stale and false R API assertions in the canonical rSHUD/AutoSHUD reviewer reference. Its 35 existing Source rows are bare text and unenrolled in the path gate, so neither their missing paths nor misleading facts are checked. The actual disposable baseline confirms a nonexistent backticked R path passes default checking before enrollment, fails explicit checking, and a valid replacement passes.

## What Changes

Recheck the complete document against pinned rSHUD/AutoSHUD sources; correct API ownership/signatures, warning behavior, reader validation, projection/environment assumptions, tests, orchestration and source codes. Replace six stale Verified annotations with one explicit source-review baseline. Preserve the checklist's question structure but correct false premises. Normalize every citation to one backticked path with external line ranges and add this document to existing path-check enrollment.

## Capabilities

### Modified Capabilities

- `engineering-gates`: R provenance joins default path checks and distinguishes source review from runtime/scientific validation.

## Impact

Only `docs/01_CODEBASE/rSHUD_AutoSHUD_Quirks.md`, one `constraints.yaml` enrollment line, and this fixture. Existing CI already initializes all three pinned submodules; no checker, CI or scientific code changes.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; gate configuration and canonical API reference affect shared verification.
Blast radius: reviewer conclusions and default documentation gate.
Selected risk packs: Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Legacy compatibility / examples; Documentation / migration notes; Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility; Scientific governance / PI gate / evidence lineage.
Evidence floor: pinned-source claim inventory, actual negative/positive default gate probe, full check, real CI pinned checkout/path-gate output, unchanged submodule pins/bytes.
