# Proposal

## Why

#378 documents a real distinction between calling the pinned host logger and producing operator-readable evidence. In this conversation PI explicitly selected “仅记录边界，关闭 #378”; no new production logger outlet is required for this resolution. This is not M2 functional acceptance.

## What Changes

- Correct active M2 design/spec wording and canonical raw-data-guard Decision audit visibility via a MODIFIED delta; preserve all instrumentation, security restrictions and existing scenarios.
- Record current readable evidence surfaces in the canonical instruction source and regenerate its projections.
- Retain #343's instance-specific recovery facade unchanged. No general exporter, console plugin, host change, threshold change, Web log panel or additional payload exposure.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `raw-data-guard`: clarify that logger receipt is instrumentation, not durable/operator-visible audit evidence; use the already specified session events.

## Impact

Documentation only: active `m2-run-chain`, raw-data-guard spec delta, `instructions/agents/shared.md` and generated instructions. Host evidence is pinned to dsh-v0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317. Production source, tests, profiles, dependencies and R1–R12 remain unchanged.

## Fixture and evidence

Compact documentation fixture; no design.md required. Selected risk packs: Documentation / migration notes (accurate source and operator boundaries), Legacy compatibility / examples (existing logger and session contracts), Auth / permissions / secrets (no broadened payload outlet). Other packs are not selected: Public API / CLI / script entry, Config / project setup, File IO / path safety / overwrite, Schema / columns / units / field names, Error handling / rollback / partial outputs, Concurrency / shared state / ordering, Resource limits / large input / discovery, Release / packaging / dependency compatibility: none of their runtime behavior changes.

Evidence: read pinned host logger delivery/buffer, boot exporter lifetime, console plugin and startup-failure reporter; retain the reported in-process probe as historical, not a new Web end-to-end proof. Check current retained #360 runtime evidence for actual session/durable surfaces. Strict spec validation, generated instructions check, full repository check, independent documentation review and exact-head CI. No new runtime sink or complete diagnostic coverage is claimed.
