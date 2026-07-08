import type { TaskCard, TaskStatus } from "@shud-harness/core";
import { escapeHtml } from "./rendering";

export type StatusBarTaskContext = Pick<TaskCard, "task_id"> & {
  status: TaskStatus;
};

export interface StatusBarProps {
  task?: StatusBarTaskContext;
}

export function StatusBar(props: StatusBarProps = {}): string {
  if (!props.task) {
    return [
      '<footer class="status-bar" data-status-bar>',
      '<span class="status-bar__empty">等待任务上下文</span>',
      "</footer>"
    ].join("");
  }

  return [
    '<footer class="status-bar" data-status-bar>',
    `<span class="status-bar__task-id">${escapeHtml(props.task.task_id)}</span>`,
    `<span class="status-bar__status">${escapeHtml(props.task.status)}</span>`,
    "</footer>"
  ].join("");
}
