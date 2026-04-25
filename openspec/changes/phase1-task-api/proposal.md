## Why

Phase 1 needs a minimal backend contract so the frontend can create and inspect tasks through a real API instead of fixtures. The API must use the shared schemas, workspace persistence, and a consistent error envelope from the start.

## What Changes

- Add a Hono backend server entrypoint.
- Add `POST /api/workspace/init`.
- Add `POST /api/tasks`, `GET /api/tasks`, and `GET /api/tasks/:id`.
- Add API error response envelope handling.
- Add idempotency skeleton for task creation.
- Add API integration tests for success and negative cases.

## Capabilities

### New Capabilities

- `task-api`: Provides Phase 1 workspace initialization and task CRUD read/create APIs.

### Modified Capabilities

None.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/Phased_Spec_Activation.md` | Normative Phase 1 activation for CRUD API, workspace init, and API error envelope. | No RunJob, WebSocket, analysis, report, or PI gate APIs are implemented. |
| `docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md` | Normative API registry for workspace and task endpoints. | Implement only `POST /api/workspace/init`, `POST /api/tasks`, `GET /api/tasks`, and `GET /api/tasks/:id`. |
| `docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md` | Normative API error envelope, status mapping, and idempotency header rules. | Implement Phase 1 idempotency skeleton for task creation only. |
| `docs/03_SPEC/Minimal_Schemas.md` | Normative TaskCard schema contract consumed by task APIs. | API must not invent TaskCard fields outside the schema. |
| `docs/02_ARCHITECTURE/Control_Kernel.md` | Normative TaskCard state-machine context for API-created defaults. | Execution transitions are out of scope. |
| `docs/03_SPEC/Workspace_Conventions.md` | Normative runtime workspace path rules used by API services. | API may initialize/list task state only; no workspace job execution. |

## Impact

- Affected paths: backend app/server, task routes, middleware, API tests.
- Depends on `phase1-monorepo-foundation`, `phase1-core-schemas`, and `phase1-workspace-snapshot`.
- Enables the frontend shell to use live data.
