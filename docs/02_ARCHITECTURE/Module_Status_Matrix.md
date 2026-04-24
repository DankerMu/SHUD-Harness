# 模块状态矩阵：[E] / [O] / [N]

## 1. 标注含义

- **[E]**（Extend）：Zero 已有实现，直接复用或在其上扩展 SHUD 领域逻辑。
- **[O]**（Override）：Zero 有实现但需修改行为后复用。
- **[N]**（New）：Zero 无对应能力，SHUD-Harness 必须新增。

## 2. 矩阵

| 模块 | 状态 | v0.8 说明 |
|---|:---:|---|
| **Web Console（四栏工作台）** | [E]/[N] | 基于 Zero Hono+React 构建四栏科研界面：导航/Agent 活动流/实验详情/结果面板 |
| WebSocket 实时通信 | [E] | 复用 Zero WebSocket，承载对话流 + 日志流 + job 完成推送 |
| Session 管理 | [E] | 复用 Zero Session，多会话 + 状态持久化 |
| PI 审批 UI | [N] | Web 内审批按钮，触发 ChangeRequest gate |
| TaskCard | [N] | 统一承载工程/科学辅助/运维任务 |
| Coordinator kernel | [E]/[N] | 复用 Zero AgentLoop + Hook，扩展 Brief/Plan/Park/Resume/Report |
| Worker Agent | [E] | 复用 Zero spawn/wait，执行编译/运行/后处理 |
| Reviewer Agent | [E]/[N] | 复用 Zero Role system，只做工程/报告完整性检查 |
| Bash sandbox | [E]/[N] | 复用 Zero BashTool，添加 workspace 路径约束 + data/raw 只读 |
| Job manager | [N] | 长任务 submit → Park → poll → collect → Resume |
| RunJob / RunRecord | [N] | SHUD 运行提交与结果记录 |
| StackLock | [N] | 锁定 env + harness + SHUD commit 版本 |
| DataProvenance | [N] | 数据来源/预处理/观测记录 |
| AnalysisPlan | [N] | sensitivity / calibration / benchmark 三类分析 |
| EvidenceReport | [N] | Markdown 报告生成，Web 结果面板展示 |
| ChangeRequest | [N] | 变更请求 + 兼容性检查 + PI gate |
| Memory notes | [O]/[N] | 复用 Zero Memory，禁用默认 verified，改为 draft + PI review 两级 |
| Skills | [E]/[N] | 复用 Zero SKILL.md loader，加载 5 个 SHUD 专用 skill |
| Cost budget | [N] | cheap/normal/deep 三档，Web Dashboard 软监控 |
| Data storage | [N] | DuckDB/Parquet/artifact retention |
| Failure recovery | [N] | worktree rollback、job retry、state machine |
| Incremental benchmark | [N] | 根据变更影响选择 smoke/regression |

## 3. MVP 必做模块（Week 1–4）

```text
- Web Console 四栏骨架（Hono API + React 壳 + WebSocket）
- TaskCard + Zod schema
- Coordinator kernel（AgentLoop 扩展 + Park/Resume）
- Bash sandbox（workspace 约束）
- Job manager local backend
- RunJob / RunRecord
- StackLock
- DataProvenance
- EvidenceReport markdown 生成 + Web 结果面板
- ChangeRequest + PI 审批 UI
- Memory notes（draft + PI review）
- 5 个基础 skills
- Cost budget 仪表盘
```

## 4. 不做（超出 v0.8 范围）

```text
- Harness Optimizer
- full Critic workflow
- release platform
- multi-agent swarm
- CLI task manager（已被 Web Console 取代）
```
