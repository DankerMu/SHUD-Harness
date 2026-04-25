## Context

The product direction is Web-first: PI users should interact with tasks through a browser workbench. Phase 1 only needs a skeleton that can create/select/read tasks and survive refresh from persisted snapshot state.

## Goals / Non-Goals

**Goals:**

- Implement a clear Dashboard to Workbench flow using live backend APIs.
- Establish the four-panel layout from the interaction model.
- Display initial task context, status, and budget information.
- Keep placeholders explicit where later phases will add agent activity, runtime terminal, charts, and reports.

**Non-Goals:**

- No WebSocket streaming.
- No real hydrograph chart, runtime terminal, sensitivity grid, PI decision panel, or notification UI.
- No design-system polish beyond the Phase 1 shell and token baseline.

## Decisions

- Use state-based navigation or the existing frontend router convention introduced by the foundation. The UI must not depend on browser-only state for current task recovery.
- Use a typed API client that imports shared types from core schemas.
- Keep the four panel components shallow and composable so later phases can replace placeholders without layout rewrites.
- Reserve AgentActivityFeed role rendering for Coordinator, Repo Explorer, Worker, Coder, Reviewer, and PI/client sources even when Phase 1 uses placeholders only.
- Render empty/loading/error states explicitly; do not silently hide backend failures.

## Risks / Trade-offs

- Building UI before WebSocket may lead to placeholder churn. Mitigation: label placeholders and keep contracts to API-backed task state only.
- Styling can consume time. Mitigation: implement intentional but minimal shell styling, deferring advanced visuals to later UI-specific work.
- Frontend may drift from backend response types. Mitigation: use core types and API smoke tests.

## Migration Plan

- Add Dashboard and Workbench shell.
- Add API client methods for Phase 1 endpoints.
- Add smoke tests that create a task, navigate to Workbench, and reload state.

## Open Questions

- Whether Phase 1 uses React Router or simple state-based routing should be decided by the existing app scaffold when implemented.
