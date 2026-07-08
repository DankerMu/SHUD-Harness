import { describe, expect, test } from "bun:test";

import type { TaskCard } from "@shud-harness/core";
import { ExperimentHeader, StatusBar } from "./index";

describe("ExperimentHeader and StatusBar placeholders", () => {
  test("render selected TaskCard id and status from shared task context", () => {
    const task = taskCardFixture();

    const header = ExperimentHeader({ task });
    const statusBar = StatusBar({ task });

    expect(header).toContain('<h2 class="experiment-header__task-id">TASK-M1-36-HEADER</h2>');
    expect(header).toContain("<strong>running</strong>");
    expect(statusBar).toContain('<span class="status-bar__task-id">TASK-M1-36-HEADER</span>');
    expect(statusBar).toContain('<span class="status-bar__status">running</span>');
  });

  test("render stable empty task-context states", () => {
    const header = ExperimentHeader();
    const statusBar = StatusBar();
    const combined = `${header}${statusBar}`;

    expect(header).toContain('<p class="experiment-header__empty">未选择任务</p>');
    expect(statusBar).toContain('<span class="status-bar__empty">等待任务上下文</span>');

    for (const output of [header, statusBar, combined]) {
      expect(output).not.toContain("undefined");
      expect(output).not.toContain("[object Object]");
    }
  });
});

function taskCardFixture(): TaskCard {
  return {
    task_id: "TASK-M1-36-HEADER",
    type: "engineering",
    status: "running",
    title: "Header and status bar fixture",
    question_or_goal: "验证 ExperimentHeader 和 StatusBar 的任务上下文字段绑定。",
    created_by: "pi",
    current_owner: "coordinator",
    reviewer: "reviewer",
    inference_budget: { mode: "normal" },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-07-08T05:00:00.000Z",
    updated_at: "2026-07-08T05:00:00.000Z"
  };
}
