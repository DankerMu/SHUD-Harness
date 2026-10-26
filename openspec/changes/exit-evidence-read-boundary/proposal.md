## Why

#360 identifies inconsistent exit authority: settlement follows an exit_code symlink and can persist its target's number, while collection rejects that path. A FIFO can leave the reader waiting indefinitely. The boundary belongs in the single shared reader, not eight caller-specific guards.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (shared file reader, path safety and settlement evidence)
Blast radius: numeric exit authority, online/startup settlement, cancellation and collection.
Selected risk packs: File IO / path safety / overwrite; Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: real symlink semantic RED; externally bounded FIFO RED/GREEN; reader and settlement/collector regressions; default check; built profile, tiny solver and real Web restart smoke; exact-head CI and independent white-box review.

## What Changes

Bind exit_code reading and regular-file validation to one non-following, nonblocking descriptor, close it on every acquired-handle path, and keep the existing absent/invalid/unreadable result model. Preserve collector prechecks for their existing controlled diagnostics. Migrate existing filesystem fault/barrier test seams without weakening their assertions.

## Capabilities

### Modified Capabilities

- `shud-run-jobs`: shared exit-code regular-file read boundary, sibling to the existing stdout boundary.

## Impact

Runtime change is confined to shud-exit.ts. Tests cover the shared reader, one real settlement path and existing collect/cancel fault consumers. Update the active M2 design's settlement/risk text; no schema, wrapper writer, stdout, host, dependency or CI changes. Hardlinks, ancestor replacement and same-user regular-file replacement remain accepted residuals, not newly claimed protections. This is evidence integrity under the existing single-user model, not a claimed cross-user exploit.
