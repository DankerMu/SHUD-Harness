import { escapeHtml } from "../components";
import { WORKBENCH_LAYOUT_CSS, renderWorkbenchLayout } from "../layouts";

export const WORKBENCH_ROUTE = "/workbench" as const;

export interface WorkbenchPageOptions {
  activeTaskId?: string;
}

export function renderWorkbenchPage(options: WorkbenchPageOptions = {}): string {
  return renderWorkbenchLayout({
    sideNav: {
      activeTaskId: options.activeTaskId
    }
  });
}

export function renderWorkbenchDocument(options: WorkbenchPageOptions = {}): string {
  const title = "SHUD Harness 工作台";

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${WORKBENCH_LAYOUT_CSS}</style>`,
    "</head>",
    "<body>",
    renderWorkbenchPage(options),
    "</body>",
    "</html>"
  ].join("");
}

export function renderWorkbenchRoute(
  path: string,
  options: WorkbenchPageOptions = {}
): string | undefined {
  return path === WORKBENCH_ROUTE ? renderWorkbenchDocument(options) : undefined;
}
