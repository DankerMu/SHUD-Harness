# Proposal

## Why

PI chose safe ownership plus explicit diagnostics in issue #343 comments 6397949594 and 6399764892. The latter expressly accepts log-only distinction: no new durable field/file and no permanent RunRecord proof of historical group quiescence. Existing R7 cancellation/lost classification must not be read as proof every descendant stopped.

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Critical Path #4 startup reconciliation, signal ownership and truthful diagnostics.
Selected risk packs: Public entry; Concurrency/state; Error handling; Resource limits; Legacy compatibility; Documentation; Auth/permissions.
Evidence floor: warning RED/GREEN through actual stderr delivery, unchanged signal/outcome controls including retained R8 ownership, native Darwin orphan replacement smoke, full check/profile/restart and exact-head CI.

## What Changes

Emit a contextual warning after successful unowned R7 terminal settlement, after the exit reread and before collection. Distinguish an instance that already retained R8 group control: do not incorrectly warn that its controlled, quiescent group was unverified. Preserve all classification, control, storage and notification behavior.

## Capabilities

### Modified Capabilities

- `shud-run-jobs`: disclose unknown historical group quiescence through a bounded Cordis logger-to-stderr route, without adding durable evidence or unsafe group operations.

## Impact

Poll diagnostic boundary, registry warning injection and narrowly scoped stderr exporter, and a read-only query of existing recovered cancellation ownership; existing native tests/harness stderr capture; M2 normative descriptions/current runtime docs/instruction source as needed. Stock logger emission alone is invisible on successful host boot, so actual stderr delivery is required. Only this instance's dedicated recovery facade is forwarded, not existing errors or unrelated plugins. No signal path, row/action classifier, schema, persistent field/file, dependency, cadence, notification text or PI approval changes. Independent fixture archive never archives M2.
