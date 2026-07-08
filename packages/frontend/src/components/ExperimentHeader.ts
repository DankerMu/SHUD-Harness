import type { TaskCard, TaskStatus } from "@shud-harness/core";
import { escapeHtml } from "./rendering";

export type ExperimentHeaderTaskContext = Pick<TaskCard, "task_id"> & {
  status: TaskStatus;
};

export interface ExperimentHeaderProps {
  task?: ExperimentHeaderTaskContext;
}

export function ExperimentHeader(props: ExperimentHeaderProps = {}): string {
  if (!props.task) {
    return [
      '<header class="experiment-header" data-experiment-header>',
      '<p class="experiment-header__empty">未选择任务</p>',
      "</header>"
    ].join("");
  }

  const taskId = escapeHtml(props.task.task_id);
  const status = escapeHtml(props.task.status);

  return [
    '<header class="experiment-header" data-experiment-header>',
    '<span class="experiment-header__eyebrow">TaskCard</span>',
    `<h2 class="experiment-header__task-id">${taskId}</h2>`,
    `<p class="experiment-header__status"><span>status</span><strong>${status}</strong></p>`,
    "</header>"
  ].join("");
}
