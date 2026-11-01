---
status: accepted
kind: process
---

# ADR-0010: M3 Epic 统一 PI 功能验收

## 背景与依据

[ADR-0005](../implemented/0005-epic-210-acceptance.md) 与 [ADR-0007](../implemented/0007-m2-epic-acceptance.md) 分别限定 M1、M2 的统一验收，不自动推广。M3 的 TaskCard、worker 运行/收集、报告生成/校验和审批往返只有在完整链路组装后才能由 PI 验收。

本记录按 [M3 design D12](../../../openspec/changes/archive/2026-11-01-m3-mvp-1/design.md#d12-验收门与-pi-验收)、[Epic-close PI acceptance](../../../openspec/specs/agent-presets/spec.md#requirement-epic-close-pi-acceptance) 与 [#451](https://github.com/DankerMu/SHUD-Harness/issues/451) 登记 [Epic #423](https://github.com/DankerMu/SHUD-Harness/issues/423) 的既定验收安排。PI 已于 2026-11-01 明确通过 M3 功能验收，由 [#452](https://github.com/DankerMu/SHUD-Harness/issues/452) 完成本记录的 implemented / accepted 收口。

## 验收安排

1. M3 子 PR 完成本地规定检查、适用的真实运行 smoke、风险对应的独立审查与 CI `all-checks-passed` 后可合并，关闭对应实现 issue；保留提交 SHA、工程验证、审查与偏离记录。
2. 子 PR 合并和 `shud:first-task` 自动 Allow once 仅证明工程链路，不表示 PI 接受报告的科学内容或 M3 功能验收通过。
3. PI 在 `dsh --profile shud` 的 Web 中亲自完成首任务，至少包含一次 `report_submit` 的 Allow once，以及一次拒绝 → 对话中给出 comment → `report_decide` 二次审批的完整往返。Agent 不得代批或以模拟事件、脚本自动审批替代这些操作。
4. 证据写入 `docs/Migration_Plan_dsh.md`：实际 session log 路径、同调用 `approval/asked|decided` 的事件序列摘录、工作区 task/report 文件路径、PI 明确验收结论。拒绝本身不生成决定；comment 与 `report_decide` 的后续决定必须由实际日志和文件相互关联。
5. 在工程事项与验收证据齐备且 PI 明确通过前，#452、Epic #423 保持 open，`m3-mvp-1` 保持未归档，本 ADR 保持 proposed。通过后才由 #452 将本 ADR 转入 implemented、登记 accepted 并完成 Epic/OpenSpec 收口；若未通过，保留 open，按具体证据修复。

## 工程门与不变项

`pnpm run check` 与 `pnpm run profile:smoke` 保持原门禁；`pnpm run shud:first-task <scratch-workspace>` 登记为本机 block，需本机可执行 SHUD（显式绝对路径 `SHUD_BIN`）及环境变量 `DMXAPI_KEY`，CI 不运行。它使用独立 Web profile，以同提交审批审计、worker 收集和工作区文件联合判定；工作区可在 `$TMPDIR`。`shud:tiny`、`shud:restart` 仍是独立本机闸，不被首任务脚本替代。

审查轮次、覆盖率、PR 体积、密钥与 raw 数据保护、seam-only、真实 LLM 探针要求均不放宽。运行时物理方程、默认参数、benchmark 与报告审批权限不变；语义和科学合规仍由 PI 判断。

## 权衡与适用范围

收益是 PI 面向完整用户链路验收，避免每个工程切片重复打断；代价是 main 可包含尚未功能验收的切片。通过逐 PR 可追溯证据、明确区分工程交付与 PI 验收，以及保留 Epic open 控制该风险。本安排只覆盖 M3 Epic #423，不成为其它 Epic 或独立 issue 的默认例外。

## PI 验收结论（2026-11-01）

PI 逐项确认两条实际 Web 路径：report_submit 的 Allow once 得到 accepted / TaskCard done；另一报告先人工拒绝提交，单给 comment 时模型追问处置，随后 PI 明确 revision_requested 并亲自允许 report_decide 第二张卡，得到 revision_requested / TaskCard planned。A12 明确选择「通过 M3 阶段验收」，授权正式记录、归档与关闭 #452/#423；实际日志路径、审批 id/callId、六字段历史及文件状态见 [M3 PI acceptance](../../Migration_Plan_dsh.md#m3-pi-acceptance)。

验收中的 #511 full-access 自动拒绝已修复并经 PI 重验；原自动拒绝不计作人工操作。PI 知悉两条 worker 作业通知仍为 unreachable，闭环依赖显式等待/收集；不声称自动唤醒或科学/数值验证成功，不放宽独立重启闸，#422 指标生产仍属于 M5。本结论不追认自动工程审批为 PI 操作，也不推广其它 proposed ADR。
