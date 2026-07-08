import {
  createAgentActivityFeedPanel,
  createExperimentPanel,
  createResultsPanel,
  createSideNavPanel,
  renderPanel,
  type SideNavPlaceholderProps
} from "../components";

export interface WorkbenchLayoutProps {
  sideNav?: SideNavPlaceholderProps;
}

export const WORKBENCH_LAYOUT_PANEL_SLOTS = [
  "side-nav",
  "agent-feed",
  "experiment",
  "results"
] as const;

export function renderWorkbenchLayout(props: WorkbenchLayoutProps = {}): string {
  const panels = [
    createSideNavPanel(props.sideNav),
    createAgentActivityFeedPanel(),
    createExperimentPanel(),
    createResultsPanel()
  ];

  return `<main class="workbench" data-workbench-layout="four-column">${panels
    .map((panel) => renderPanel(panel))
    .join("")}</main>`;
}

export const WORKBENCH_LAYOUT_CSS = `
:root {
  color-scheme: light;
  --workbench-bg: #f6f8fb;
  --panel-bg: #ffffff;
  --panel-border: #d8dee8;
  --text-primary: #172033;
  --text-muted: #5e6a7d;
  --accent-blue: #2563eb;
  --accent-teal: #0f766e;
  --accent-green: #15803d;
  --accent-amber: #b45309;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  background: var(--workbench-bg);
  color: var(--text-primary);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.workbench {
  display: grid;
  grid-template-columns: 240px minmax(320px, 1fr) minmax(400px, 1.5fr) minmax(280px, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 0;
  height: 100vh;
  min-height: 520px;
  overflow: hidden;
}

.workbench-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--panel-border);
  background: var(--panel-bg);
}

.workbench-panel:last-child {
  border-right: 0;
}

.workbench-panel__header {
  min-height: 64px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--panel-border);
  min-width: 0;
}

.workbench-panel__header span {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 16px;
}

.workbench-panel__header h2 {
  margin: 4px 0 0;
  font-size: 18px;
  line-height: 24px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.workbench-panel__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.workbench-panel__body p {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.workbench-panel__list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workbench-panel__list li {
  min-height: 36px;
  padding: 9px 10px;
  border: 1px solid var(--panel-border);
  border-left: 4px solid var(--accent-blue);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 18px;
  background: #fbfcfe;
  overflow-wrap: anywhere;
}

.workbench-panel--agent-feed .workbench-panel__list li {
  border-left-color: var(--accent-teal);
}

.workbench-panel--experiment .workbench-panel__list li {
  border-left-color: var(--accent-green);
}

.workbench-panel--results .workbench-panel__list li {
  border-left-color: var(--accent-amber);
}

.workbench-panel__footer {
  min-height: 36px;
  padding: 9px 16px;
  border-top: 1px solid var(--panel-border);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 16px;
  overflow-wrap: anywhere;
}

@media (max-width: 1279px) {
  .workbench {
    grid-template-columns: 56px minmax(320px, 1fr) minmax(420px, 1.4fr);
    grid-template-rows: minmax(320px, 1fr) minmax(220px, 0.7fr);
    overflow: auto;
  }

  .workbench-panel--results {
    grid-column: 2 / 4;
    grid-row: 2;
    border-top: 1px solid var(--panel-border);
  }
}

@media (max-width: 795px) {
  .workbench {
    grid-template-columns: 1fr;
    grid-template-rows: repeat(4, minmax(220px, 1fr));
    height: auto;
    overflow: visible;
  }

  .workbench-panel,
  .workbench-panel--results {
    display: flex;
    grid-column: auto;
    grid-row: auto;
    border-right: 0;
    border-bottom: 1px solid var(--panel-border);
  }
}
`;
