import type { WorkbenchPanel } from "./rendering";

export function createResultsPanel(): WorkbenchPanel {
  return {
    slot: "results",
    eyebrow: "结果",
    title: "证据",
    body: "尚无 EvidenceReport。",
    items: ["NSE --", "洪峰误差 --", "耗时 --", "报告草稿 --"],
    footer: "等待 PI 决策"
  };
}
