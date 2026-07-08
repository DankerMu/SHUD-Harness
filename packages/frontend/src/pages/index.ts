export const FRONTEND_PAGES_NAMESPACE = "frontend/pages" as const;

export type FrontendPagesNamespace = typeof FRONTEND_PAGES_NAMESPACE;

export * from "./Dashboard";
export * from "./Workbench";
