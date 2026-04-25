## Why

Phase 1 needs a user-visible shell that proves the web-first interaction model can read live backend state. The UI should establish layout and navigation without pretending to run agents or scientific jobs.

## What Changes

- Add React frontend app shell.
- Add Dashboard task list page.
- Add Workbench four-panel layout with SideNav, AgentActivityFeed placeholder, ExperimentHeader, Results placeholder, and StatusBar.
- Add typed API client for workspace init and task create/list/read.
- Add UI smoke tests for dashboard-to-workbench navigation and refresh recovery.

## Capabilities

### New Capabilities

- `web-workbench-shell`: Provides the Phase 1 Dashboard and four-panel Workbench shell backed by live task APIs.

### Modified Capabilities

None.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/Phased_Spec_Activation.md` | Normative Phase 1 activation for Dashboard, Workbench four-panel shell, SideNav, ExperimentHeader, and StatusBar. | Agent streaming, runtime terminal logs, charts, reports, and PI decisions are placeholders only. |
| `docs/02_ARCHITECTURE/Interaction_Model.md` | Normative four-panel workbench information architecture. | Implement layout shell and task context only; no scientific visualization behavior. |
| `docs/03_SPEC/UI_Implementation_Spec.md` | Normative UI implementation tokens and component expectations. | Implement minimal token baseline; full visual system can mature later. |
| `docs/03_SPEC/UX_Design_Spec.md` | Reference for user journey and workbench interaction requirements. | Use Phase 1 journey subset only: create/select/read task. |
| `docs/03_SPEC/Frontend_State_Design.md` | Phase 1 subset reference for API-backed task context and refresh recovery. | WebSocket reducer/entity cache details are Phase 2+ and out of scope. |
| `docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md` | Normative API contract used by the frontend API client. | Frontend calls only Phase 1 workspace/task endpoints. |

## Impact

- Affected paths: frontend app, API client, UI components, UI tests.
- Depends on `phase1-monorepo-foundation`, `phase1-core-schemas`, and `phase1-task-api`.
- Does not implement real AgentLoop, WebSocket streams, RunJob logs, charts, or report rendering.
