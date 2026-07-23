export const FRONTEND_PAGES_NAMESPACE = "frontend/pages" as const;

export type FrontendPagesNamespace = typeof FRONTEND_PAGES_NAMESPACE;

export * from "./Workbench";
export {
  DASHBOARD_ALTERNATE_ROUTE,
  DASHBOARD_CSS,
  DASHBOARD_ROUTE,
  DASHBOARD_TASKS_ENDPOINT,
  DashboardTaskApiError,
  createDashboardController,
  createDashboardTask,
  dashboardCreateTaskBody,
  listDashboardTasks,
  renderDashboardDocument,
  renderDashboardFromServer,
  renderDashboardPage,
  renderDashboardRoute,
  type DashboardBudgetMode,
  type DashboardCreateTaskInput,
  type DashboardFetch,
  type DashboardFormValues,
  type DashboardRenderState
} from "./Dashboard";

import { HARNESS_API_CLIENT_SCRIPT } from "../api";
import { DASHBOARD_CREATE_FORM_SCRIPT as DASHBOARD_PAGE_SCRIPT } from "./Dashboard";

// The isolated inline-script unit harness has no Window.location. Prefix the
// same API-layer installer used by the rendered document so M1 interaction
// regression tests still execute the migrated wrapper path.
export const DASHBOARD_CREATE_FORM_SCRIPT = `${HARNESS_API_CLIENT_SCRIPT}\n${DASHBOARD_PAGE_SCRIPT}`;
