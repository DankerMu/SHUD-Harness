## Context

`docs/03_SPEC/Minimal_Schemas.md` and `docs/03_SPEC/Support_Schema_Contracts.md` define the Phase 1 object contracts. Once implementation begins, Zod schemas become the highest fact source, so this changeset creates a minimal schema layer before runtime behavior is built.

## Goals / Non-Goals

**Goals:**

- Implement the Phase 1 schema subset needed by workspace init, task CRUD, error handling, and idempotency.
- Export both schemas and inferred types from a single core package.
- Make invalid payload behavior explicit through unit tests.

**Non-Goals:**

- Do not implement all v0.8 schemas.
- Do not implement generated Markdown/JSON Schema output beyond placeholders needed by later quality gates.
- Do not implement persistence or API routes.

## Decisions

- Use one file per schema to mirror the canonical docs and keep drift review simple.
- Use strict object parsing for externally supplied payloads so unknown fields are caught early where appropriate.
- Keep ID validation format-based but not globally uniqueness-aware; uniqueness belongs to workspace/id services.
- Treat timestamps as ISO string fields in Phase 1. Stronger date wrappers can be added only if API and persistence layers need them.
- Define shared agent role/source enums up front, including `repo_explorer`, even though Phase 1 does not implement the agent runtime. This prevents WebSocket/UI/auth schemas from diverging when Phase 2 adds RepoContextBrief.

## Risks / Trade-offs

- Over-validating early can slow iteration. Mitigation: enforce only canonical fields needed in Phase 1 and defer optional support schemas.
- Under-validating allows drift from docs. Mitigation: add negative tests for enum and required-field failures.
- Schema generation may be deferred. Mitigation: quality gates will add drift checks once scripts exist.

## Migration Plan

- Add schema files and exports to `packages/core`.
- Add tests and fixtures.
- Update downstream changes to import only from the core package.

## Open Questions

- Whether `schema_version` is required on every persisted object in Phase 1 should be confirmed before persistence implementation.
