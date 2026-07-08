import type { WorkbenchPanel } from "./rendering";

export interface SideNavPlaceholderProps {
  activeTaskId?: string;
}

export function createSideNavPanel(props: SideNavPlaceholderProps = {}): WorkbenchPanel {
  const activeTaskId = props.activeTaskId ?? "TASK-M1-DEMO";

  return {
    slot: "side-nav",
    eyebrow: "任务",
    title: activeTaskId,
    body: "已创建",
    items: ["任务卡", "分析计划", "证据报告", "变更请求"],
    footer: "M1 工作台壳"
  };
}
