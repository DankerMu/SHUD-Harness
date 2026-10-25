# Proposal

## Why

Issue #340 identifies an unused partial parent-default fallback that falsely suggests direct construction without parsed configuration is supported. The supported Cordis path already supplies resolved defaults; the fallback can hide an invalid constructor precondition while leaving other parent limits undefined.

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: registry construction and the shared producer/execution/poll cadence.
Selected risk packs: Public API / entry; Config / project setup; Concurrency / ordering; Error handling; Documentation.
Evidence floor: direct-construction semantic RED/GREEN, unchanged parsed-default/configured cadence tests, full check and built runtime/profile smoke.
Expanded reason: production configuration and registry entrypoint are explicit expanded triggers, despite the small patch.

## What Changes

Delete the partial fallback and misleading comment. Read the already-resolved cadence once, require a positive safe integer before acquiring ownership or constructing the parent, and fail with a message pointing to parsed Config/Cordis plugin configuration otherwise. Keep parent keys optional for plugin input; do not support direct construction or fill other defaults.

## Capabilities

### Modified Capabilities

- `shud-run-jobs`: add an explicit fail-loud construction precondition while preserving the supported plugin configuration surface and shared cadence.

## Impact

`registry.ts`, corresponding behavioral tests, current instruction source/rendered cadence description and the matching Repository_Layout/project-profile descriptions. No schema/default, signature, dependency, host, lock/queue/kill/collection algorithm or M2 historical record changes.
