# Proposal

## Why

Issue #336 identifies unusable SHUD_IO_Facts citations and a documentation gate that cannot inspect them. Current pinned-source review finds 46 Source rows, 18 dead paths and 5 wrong-file citations, not the issue's historical 44/22/27 counts. The document must be usable by implementers without turning path existence into a scientific claim.

## What Changes

- Normalize all SHUD_IO_Facts Source paths to independently backticked repository paths with line references outside the backticks; correct current broken paths, wrong state-vector sources and the issue's time/header/arithmetic/warning facts against SHUD `3aec65755926c478e13ca7d4fea80715e4e90345`.
- State the actual review baseline and limited provenance scope; preserve the exit-code anchor/values and review checklist, existing END updater contract, scientific algorithms and submodule bytes.
- Enroll that document in the existing path-claim list; make only the CI docs-gate checkout initialize pinned submodules. Keep the checker and all other gate commands unchanged; verify actual CI checkout rather than asserting missing roots fail closed.
- Route the optional sibling rSHUD/AutoSHUD document to a separate issue as #336 explicitly permits: fresh research shows a larger API/source drift requiring its own bounded repair. Do not claim that file refreshed or enroll its unresolved citations here.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `engineering-gates`: pinned SHUD source citations are machine-discovered with real submodule content in CI.

## Impact and triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; the issue calls this doc-only, overridden because shared gate configuration and CI checkout behavior change.
Blast radius: documentation provenance and path-gate discovery; no runtime/model changes.
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Legacy compatibility / examples; Documentation / migration notes; domain Scientific governance / PI gate / evidence lineage; domain Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility (read-only citation boundary).
Evidence floor: pinned per-row source inventory, actual bad/good citation gate controls, full check and guardrail self-test, strict validation, exact-head CI with observed pinned submodule checkout.
