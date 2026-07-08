import type { WorkbenchPanel } from "./rendering";

export function createExperimentPanel(): WorkbenchPanel {
  return {
    slot: "experiment",
    eyebrow: "实验",
    title: "运行工作区",
    body: "当前没有运行中的 RunJob。",
    items: ["SHUD pin：待定", "StackLock：待定", "DataProvenance：待定"],
    footer: "本机 workspace"
  };
}
