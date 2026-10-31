# Repository root whitespace fidelity

## Why

Issue #463: trimming git top-level stdout removes legal pathname whitespace, so a committed repository whose basename ends in a space is rejected as a non-root. Preserve pathname content while retaining the existing enclosing-repository rejection.

## What Changes

- Remove only git's final LF record terminator from top-level output; keep all path characters.
- Add real-git regression coverage and document the boundary; no new git invocation or API/schema change.

## Capabilities

### Modified Capabilities
- `stack-lock`: explicit repository-root pathname fidelity, supplementing existing read-only collection.

## Impact

Core repository collector, its existing tests and Minimal_Schemas documentation; records capture consumes the unchanged API. No host, submodule or M3 acceptance change.

## Risk triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (public API and path reader require expanded)
Blast radius: legitimate configured repository roots / rejection of enclosing repositories
Selected risk packs: Public API; File IO/path safety; Error handling; Documentation
Evidence floor: real-git RED/GREEN; parent rejection; unchanged four read-only calls; built public-entry smoke; default check; strict fixture validation
