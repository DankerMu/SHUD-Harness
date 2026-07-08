import { describe, expect, test } from "bun:test";

import {
  WORKBENCH_LAYOUT_CSS,
  WORKBENCH_LAYOUT_PANEL_SLOTS,
  WORKBENCH_ROUTE,
  renderWorkbenchDocument,
  renderWorkbenchRoute
} from "../index";

describe("Workbench shell", () => {
  test("renders the browser-openable four-column workbench document", () => {
    const longTaskId =
      "TASK-M1-UI-EXTREMELY-LONG-IDENTIFIER-WITHOUT-SPACES-000000000000000000000000000000";
    const observedConsoleErrors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      observedConsoleErrors.push(args);
    };

    try {
      const document = renderWorkbenchDocument({ activeTaskId: "TASK-M1-UI" });

      expect(observedConsoleErrors).toEqual([]);
      expect(document.startsWith("<!doctype html>")).toBe(true);
      expect(document).toContain('<html lang="zh-CN">');
      expect(document).toContain("<title>SHUD Harness 工作台</title>");
      expect(document).toContain('data-workbench-layout="four-column"');
      expect(document).toContain("TASK-M1-UI");
      expect(renderWorkbenchDocument({ activeTaskId: longTaskId })).toContain(
        "TASK-M1-UI-EXTREMELY-LONG-IDENTIFIER-WITHOUT-SPACES"
      );
      expect(document).not.toContain("undefined");
      expect(document).not.toContain("[object Object]");

      for (const slot of WORKBENCH_LAYOUT_PANEL_SLOTS) {
        expect(document.match(new RegExp(`data-panel="${slot}"`, "g")) ?? []).toHaveLength(1);
      }
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("exposes the Workbench route skeleton without wiring Dashboard navigation", () => {
    expect(renderWorkbenchRoute(WORKBENCH_ROUTE)).toContain("Agent 动态");
    expect(renderWorkbenchRoute("/")).toBeUndefined();
  });

  test("keeps the desktop four-column grid contract stable", () => {
    expect(WORKBENCH_LAYOUT_CSS).toContain(
      "grid-template-columns: 240px minmax(320px, 1fr) minmax(400px, 1.5fr) minmax(280px, 1fr)"
    );
    expect(WORKBENCH_LAYOUT_CSS).toContain("@media (max-width: 1279px)");
    expect(WORKBENCH_LAYOUT_CSS).toContain("@media (max-width: 795px)");
    expect(WORKBENCH_LAYOUT_CSS).not.toContain("@media (max-width: 767px)");
    expect(WORKBENCH_LAYOUT_CSS).not.toContain("display: none");
    expect(WORKBENCH_LAYOUT_CSS).toContain("grid-column: 2 / 4");
    expect(WORKBENCH_LAYOUT_CSS).toContain("grid-column: auto");
    expect(WORKBENCH_LAYOUT_CSS).toContain("grid-row: auto");
    expect(WORKBENCH_LAYOUT_CSS).toContain("overflow-wrap: anywhere");
    expect(WORKBENCH_LAYOUT_CSS).toContain("overflow: auto");
  });
});
