## Context

Phase 1 is complete only when a developer can create a task through the UI, persist it through the API/workspace layer, refresh, and verify the skeleton through repeatable commands. This changeset collects the cross-cutting verification work that should not be buried in feature changes.

## Goals / Non-Goals

**Goals:**

- Provide one command or documented command set for Phase 1 verification.
- Check schema, API, workspace snapshot, UI smoke, docs links, and requirements ID uniqueness.
- Add liveness and readiness health checks appropriate for the deterministic skeleton.

**Non-Goals:**

- No real SHUD tiny run checks.
- No WebSocket, RunJob, artifact evidence, or observability dashboard checks beyond Phase 1 smoke.
- No full release pipeline.

## Decisions

- Keep quality gates runnable locally first; CI can call the same scripts later.
- Make `/api/health/live` process-only and `/api/health/ready` verify workspace and core persistence dependencies without leaking sensitive absolute paths.
- Keep docs checks smoke-level in Phase 1 to avoid blocking implementation on full Markdown linting.
- Treat missing Bun or missing dependencies as setup failures, not test failures.

## Risks / Trade-offs

- A final gate can become a dumping ground for unrelated work. Mitigation: only include checks tied to Phase 1 exit criteria.
- UI smoke tests may be brittle. Mitigation: use stable semantic selectors or text tied to Phase 1 requirements.
- Docs link checks can be noisy. Mitigation: start with local relative links used by activated Phase 1 docs.

## Migration Plan

- Add health endpoints if not already present.
- Add verification scripts and test grouping.
- Run all Phase 1 checks from a clean workspace.

## Open Questions

- CI provider and exact workflow filenames can remain open until implementation starts, but commands must be CI-compatible.
