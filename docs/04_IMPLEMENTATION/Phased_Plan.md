---
status: living
canonical_for: [implementation-plan]
supersedes: Zero 时代 M1–M9 计划（见 tag archive/zero-v0.8.3）
---

# 里程碑计划 v2（dsh 内核）

> 唯一真相源：排期、交付切分、验收门以本文为准。决策依据 [ADR-0004](../adr/implemented/0004-dsh-kernel.md)。
> 弹性里程碑，无日历承诺；上一门全绿才进下一门；issue 按单 agent-PR 尺寸切。
> **作用域规则（ADR-0004 K13）**：任何 spike 不以首任务的一个用户可见步骤收尾就不准开。

## 0. 总览

编号说明：M1–M6 为本次重切编号。`Migration_Plan_dsh.md` 与 `../dsh-spike` 记录中出现的"M3 JobRegistry"沿用旧编号，对应本表 **M2**。

| 里程碑 | 主题 | 用户可见步骤 | 验收门 |
|---|---|---|---|
| M1 | 骨架：profile + bundle + raw-guard 插件（包：`dsh-shud-core` 库 + `dsh-shud-raw-guard`） | 在 `dsh --profile shud` 里对话：写 raw 被拒（无审批路径），bash 读 raw 弹出 PI 审批卡 | `dsh --profile shud` 启动；raw-guard 单测 + 5 探针全绿；CI 通过 |
| M2 | 运行主链：`shud_run` + durable JobRegistry + RunRecord | 一句话跑 ccw，中途重启 dsh，完成后被唤醒并拿到 RunRecord | ccw 全程 4m45s 内 dsh 重启一次，仍产出 RunRecord 且含退出码与产物清单 |
| M3 | **MVP-1**：TaskCard + EvidenceReport + StackLock + 审批接线 | 从任务卡到 Markdown 证据报告，含 PI 审批 | 首任务"ccw 运行 → RunRecord → EvidenceReport"端到端；报告含 StackLock 三字段与响应 model |
| M4 | **MVP-2**：已知答案回放 | 提交 openMP RHS 切片 ChangeRequest，经 VerificationCase 判定 | 正确性门按 serial baseline 一致性判定（ADR-0002 D4） |
| M5 | 最小 OAT 敏感性（3–5 run，AnalysisPlan 对象） | 一次批量运行与汇总表 | 批次内 StackLock 一致；汇总表可复算 |
| M6 | 收口：记忆评估、UI 插件评估、dsh 升级评估、通知评估 | — | 每项一份一页评估，PI 决定是否立项 |

## 1. M1 骨架

**交付计划**（不是完成状态；对应 OpenSpec change [`m1-skeleton`](../../openspec/changes/archive/2026-10-21-m1-skeleton/proposal.md)、Epic #210）
- pnpm workspace：`packages/dsh-shud-core` 库（8 对象 Zod schema、治理常量、policy-gate-core 纯函数移植）、`packages/dsh-shud-raw-guard` 插件（决策核、dsh 适配层、审计与单测）、`profile/shud/` bundle（模型路由、仅关闭 `session-log-deepseek`、以 workspace 包说明符挂载 raw-guard）。
- `profile:install`：识别 checkout/npm 两种 dsh 布局，幂等建立 web 模板的 `shud` 或 headless 模板的 `shud-probe` profile；不覆盖用户 patch。
- 本机 `profile:smoke`：build → 临时 profile 建档 → dump-config/schema 自检，证明 raw-guard 可导入；`raw-guard:probes`：真实 LLM 五探针、session log 判据、负例与离线 judge 夹具自证。
- CI：typecheck + vitest + `profile-smoke` job（npm 版 dsh），结果纳入 `all-checks-passed`；真实 LLM 探针只在本机运行。
- eslint dsh seam 白名单与闸自证；Verification Matrix / Enforcement Index / constraints 同步。
- 手工 Web 验收记录读 raw 的 ask → Allow once → 工具结果，以及写 raw 的 deny 无卡，session log 与 raw md5 证据记入 Migration_Plan。此项证明用户可见步骤，不改上表验收门。
- 用户可见步骤改写依据：grill 分支⑤用户决策（[design D13](../../openspec/changes/archive/2026-10-21-m1-skeleton/design.md)）；写 raw deny 无审批路径，bash 读 raw ask。
- 移植清单执行：[Port_List](Port_List.md)。

**验收门**：上表 M1 行。**前置**：Phase 4 reset 完成（ADR-0004 K15）。

## 2. M2 运行主链

**交付**
- `dsh-shud-jobs`：实现 `ctx.jobs`（`JobRegistry` 契约）的 durable backend，替换 `jobs-local`：子进程 detach；作业记录（id、cmd、cwd、pid、started、log 路径）落盘；启动时对账（pid 存活→接管输出；已退→补 `job/settled` 并投递完成通知）；输出落文件而非仅内存 ring。
- `dsh-shud-tools`：`shud_run`（kind=shud 作业）+ `shud_collect`（解析产物 → RunRecord）。
- `RunJob`/`RunRecord` 记录经 `ctx.storage` 域持久化。

**验收门**：上表 M2 行；另加 SIGTERM 与 SIGKILL 各一次重启用例。

## 3. M3 MVP-1

**交付**：TaskCard 建卡/状态机；EvidenceReport Markdown 生成（模板 + RunRecord 引用）；StackLock（SHUD/rSHUD/AutoSHUD 版本 + 路径名 `git status` + llm 三字段）；DataProvenance 最小记录；审批接线（治理动作经 `tools/pre-execute` 返回 `ask`）；coordinator/worker 两个 agent preset。
**验收门**：首任务端到端；报告措辞通过治理四条不变式检查。

## 4. M4 MVP-2

**交付**：ChangeRequest + VerificationCase 对象；coder/reviewer preset（worktree 内改代码、生成 patch）；openMP RHS 切片回放（素材按 ADR-0002 开放项 1）。
**验收门**：ADR-0002 D4。

## 5. 全程不变式

secrets 不进 RunRecord/报告/git；agent 不作科学结论判断；高风险科学变更不绕过 PI gate；`data/raw` 在 workspace root 之外。

## 6. 升级节奏

每个里程碑边界开一条 `chore(dsh-upgrade)` issue：读上游 `docs/upgrade-guide/<tag>/`，评估 seam 影响，升级或记录跳过原因；升级后重跑 spike 五项探针（`../dsh-spike/runs/`）作为回归。
