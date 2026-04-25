## ADDED Requirements

### Requirement: Dashboard Task List

The frontend SHALL provide a Dashboard that lists persisted TaskCards from the backend task API.

#### Scenario: Tasks are displayed

- **WHEN** the Dashboard loads and the backend returns TaskCards
- **THEN** the Dashboard SHALL display the task titles, IDs, and statuses

### Requirement: Task Creation From UI

The frontend SHALL allow creating a basic Phase 1 TaskCard through the backend task API.

#### Scenario: User creates task

- **WHEN** a user submits a valid task title and goal
- **THEN** the frontend SHALL call the task creation API and display the created task in the task list

### Requirement: Four-Panel Workbench Shell

The frontend SHALL provide a Workbench shell with SideNav, Agent Activity, Experiment, Results, and StatusBar regions.

#### Scenario: Workbench opens for task

- **WHEN** a user selects a task from the Dashboard or SideNav
- **THEN** the Workbench SHALL display the selected TaskCard context in the shell regions

### Requirement: Refresh Recovery

The frontend SHALL recover the selected TaskCard from backend state after a browser refresh.

#### Scenario: Browser refresh occurs

- **WHEN** the browser refreshes while a task Workbench route or selection is active
- **THEN** the frontend SHALL fetch the TaskCard from the backend and restore the visible task context

### Requirement: Explicit Placeholder States

The Workbench SHALL make unavailable Phase 1 features visibly inactive rather than pretending they are implemented.

#### Scenario: Agent stream placeholder is shown

- **WHEN** the Workbench renders before WebSocket and AgentLoop are implemented
- **THEN** the Agent Activity region SHALL show a clear placeholder state instead of fake agent messages
