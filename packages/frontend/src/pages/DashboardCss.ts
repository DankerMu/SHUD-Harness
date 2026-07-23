export const DASHBOARD_CSS = `
:root {
  color-scheme: light;
  --dashboard-bg: #f6f8fb;
  --surface-bg: #ffffff;
  --surface-border: #d8dee8;
  --text-primary: #172033;
  --text-muted: #5e6a7d;
  --accent-blue: #2563eb;
  --accent-green: #15803d;
  --accent-amber: #b45309;
  --danger-bg: #fef2f2;
  --danger-border: #fca5a5;
  --danger-text: #991b1b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  background: var(--dashboard-bg);
  color: var(--text-primary);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.dashboard {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(320px, 420px);
  gap: 0;
  min-height: 100vh;
}

.dashboard__tasks,
.dashboard__create {
  min-width: 0;
  background: var(--surface-bg);
}

.dashboard__tasks {
  border-right: 1px solid var(--surface-border);
}

.dashboard__create {
  padding-bottom: 24px;
}

.dashboard__header {
  min-height: 72px;
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--surface-border);
}

.dashboard__eyebrow {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 16px;
}

.dashboard__header h1,
.dashboard__header h2 {
  margin: 4px 0 0;
  font-size: 20px;
  line-height: 26px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.dashboard-status,
.dashboard-empty,
.dashboard-error {
  margin: 16px 20px 0;
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.dashboard-status,
.dashboard-empty {
  color: var(--text-muted);
}

.dashboard-errors {
  display: grid;
  gap: 8px;
  margin: 16px 20px 0;
}

.dashboard-error {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--danger-border);
  border-radius: 8px;
  background: var(--danger-bg);
  color: var(--danger-text);
}

.dashboard-task-table {
  width: calc(100% - 40px);
  margin: 20px;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 14px;
  line-height: 20px;
}

.dashboard-task-table th,
.dashboard-task-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--surface-border);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.dashboard-task-table th {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 16px;
  font-weight: 650;
}

.dashboard-task-table tbody tr {
  min-height: 44px;
}

.dashboard-task-table td:first-child {
  width: 34%;
  color: var(--accent-blue);
}

.dashboard-task-table td:nth-child(3) {
  width: 120px;
  color: var(--accent-green);
  font-weight: 650;
}

.dashboard-form {
  display: grid;
  gap: 10px;
  padding: 18px 20px 0;
}

.dashboard-form label {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 18px;
}

.dashboard-form input,
.dashboard-form select,
.dashboard-form textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--text-primary);
  background: #ffffff;
  font: inherit;
  line-height: 20px;
}

.dashboard-form textarea {
  min-height: 120px;
  resize: vertical;
}

.dashboard-form button {
  min-height: 40px;
  border: 0;
  border-radius: 8px;
  padding: 10px 14px;
  background: var(--accent-blue);
  color: #ffffff;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}

.dashboard-form button:focus,
.dashboard-form input:focus,
.dashboard-form select:focus,
.dashboard-form textarea:focus {
  outline: 3px solid #bfdbfe;
  outline-offset: 1px;
}

@media (max-width: 900px) {
  .dashboard {
    grid-template-columns: 1fr;
  }

  .dashboard__tasks {
    border-right: 0;
    border-bottom: 1px solid var(--surface-border);
  }
}
`;
