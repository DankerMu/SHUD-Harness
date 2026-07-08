import type { WorkbenchPanel } from "./rendering";

export function createAgentActivityFeedPanel(): WorkbenchPanel {
  return {
    slot: "agent-feed",
    eyebrow: "活动",
    title: "Agent 动态",
    body: "Coordinator 已就绪。",
    items: ["coordinator：任务已创建", "worker：等待执行", "reviewer：待命"],
    footer: "实时流待接入"
  };
}
