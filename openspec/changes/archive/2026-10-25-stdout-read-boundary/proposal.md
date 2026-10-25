# Proposal

## Why

Issue #348 demonstrates that replacing stdout.log with a symlink can inject unrelated file bytes into model-visible job output. A FIFO replacement can block a synchronous reader. The shared output source must reject these paths without weakening normal output behavior.

## What Changes

- Open each stdout read without following its final symlink component, without blocking on FIFO, and require a regular file on the opened descriptor.
- Preserve parent warning-and-stop behavior and existing incremental UTF-8, short-read, truncation and missing-file semantics.
- Record the existing single-user hardlink/ancestor replacement residual; do not add persistent inode identity or change the schema.

## Capabilities

### New Capabilities

- `shud-run-jobs`: add only the uniquely named stdout regular-file boundary requirement. This capability is also introduced by the pending `m2-run-chain` change; this additive requirement does not duplicate or replace its requirements, and archiving this fix must not archive M2.

### Modified Capabilities

None in the current canonical spec inventory.

## Impact

Shared `file-output.ts`, its tests and real parent output integration tests; submission and R3/R5 takeover reuse the same source. No dependencies, APIs, job state, schema, output limits or host changes.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for file IO/path safety and model-visible evidence.
Blast radius: submission and takeover stdout streams.
Selected risk packs: File IO / path safety / overwrite; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: focused regressions, real parent output proof, standalone real-file smoke, full check, profile smoke, strict OpenSpec validation and independent review.
