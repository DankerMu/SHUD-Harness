## Context

The Phase 1 backend is not an agent runtime yet. It is a deterministic API layer over core schemas and workspace snapshot persistence. This creates the first runnable vertical slice without WebSocket, RunJob, or SHUD execution.

## Goals / Non-Goals

**Goals:**

- Provide a Hono API surface for workspace initialization and task create/read/list.
- Validate all request bodies and response objects through shared schemas.
- Return consistent API error envelopes for schema, not found, conflict, and server errors.
- Add minimal idempotency behavior for duplicate task create requests.

**Non-Goals:**

- No authentication or multi-user permission logic.
- No WebSocket, job execution, artifact collection, or PI gate API.
- No real LLM agent invocation.

## Decisions

- Keep backend services thin: routes delegate to workspace and task services.
- Use core schema parsing at API boundaries and before persistence writes.
- Implement idempotency as a skeleton record keyed by `Idempotency-Key`, request digest, and stored response reference. Full lock semantics can mature in later phases.
- Keep response payloads explicit and stable rather than returning raw filesystem records.

## Risks / Trade-offs

- Idempotency skeleton may be too weak for future mutating endpoints. Mitigation: design the storage shape to extend to collect/report/export later.
- No auth in Phase 1 could hide future permission requirements. Mitigation: keep middleware slots but return deterministic single-user behavior for now.
- API and workspace persistence can diverge. Mitigation: route tests must verify persisted snapshots after API calls.

## Migration Plan

- Add backend server entrypoint and route registration.
- Wire workspace and task services.
- Add integration tests using isolated temporary workspace roots.
- Keep API routes stable for frontend shell consumption.

## Open Questions

- Whether task create should accept client-provided IDs or always allocate server-side IDs should be settled during implementation. Server-side allocation is recommended.
