# Zero 路线决策：基于 Zero 扩展，构建 SHUD 领域逻辑

## 1. 当前决策

**SHUD-Harness 基于 Zero agent runtime 构建。**

Zero 提供经过验证的 agent 基础设施（AgentLoop、Session、WebSocket、Tool、Memory、Skills），SHUD-Harness 在其上扩展 SHUD 领域特定功能。

## 2. 为什么选择基于 Zero

### A. Web-first 需要完整的 agent 基础设施

SHUD-Harness 以 Web 为唯一用户交互渠道，需要：

```text
- WebSocket 实时通信（对话流 + 日志流 + 事件推送）
- Session 管理（多会话、状态持久化）
- LLM streaming（实时展示 agent 思考过程）
- Tool 执行管道（bash sandbox、文件操作）
- Hook 架构（可扩展的 agent 行为控制）
```

这些 Zero 都已实现并经过验证，从零实现需要 4-6 周，而扩展 Zero 只需专注领域逻辑。

### B. 全栈 TypeScript 降低维护成本

1.5 人团队维护一种语言 + 一套工具链，前后端共享 Zod schema 定义。

### C. Zero 架构设计与 SHUD 需求高度匹配

| Zero 能力 | SHUD-Harness 用途 |
|-----------|-------------------|
| AgentLoop + Hook | Coordinator 执行循环 + 科研治理 hook |
| Role system | Coordinator / Worker / Reviewer 角色 |
| spawn/wait agent | Coordinator spawn Worker 执行编译/运行 |
| bash tool + safety | SHUD sandbox 命令执行 |
| SKILL.md loader | 5 个 SHUD 专用 skill |
| Session + WebSocket | PI 实时对话 + 日志流 |
| Hono + React | Web 界面 (Dashboard + 审批 + 报告) |
| Memory store | note / evidence_note 两级记忆 |
| Closure Classifier | 任务完成判断（扩展为科研 closure） |

## 3. 扩展层标注

| Zero 模块 | 决策 | SHUD 扩展 |
|-----------|------|-----------|
| AgentLoop | [E] 直接复用 | 添加 Park/Resume hook |
| BashTool | [E] 直接复用 | 添加 workspace 路径约束 + data/raw 只读检查 |
| MemoryTool | [O] 修改后复用 | 禁用默认 verified, 改为 draft + PI review |
| Skills loader | [E] 直接复用 | 加载 5 个 SHUD skill |
| Spawn/Wait Agent | [E] 直接复用 | Coordinator → Worker (编译/运行/解析) |
| Web (Hono+React) | [E] 直接复用 | 添加 task/job/report/approval 页面 |
| Session | [E] 直接复用 | 添加 Park/Resume 状态持久化 |
| Closure Classifier | [O] 修改后复用 | 科研 closure (baseline? holdout? PI gate?) |
| Task Orchestrator | [E] 直接复用 | 扩展 DAG 支持长任务 park |

标注: [E] = Extend (直接扩展), [O] = Override (需修改后复用), [A] = Add (纯新增)

## 4. 必须新增的 SHUD 领域模块 [A]

```text
- Park/Resume 状态机: agent 提交 long job 后退出, job 完成后 resume
- SHUD 专用 Tool: shud-build, shud-run, rshud-parse, water-balance
- Domain schemas (Zod): TaskCard, StackLock, DataProvenance, RunJob, RunRecord, AnalysisPlan, EvidenceReport, ChangeRequest
- PI 审批界面: React 组件 (ApprovalButtons, EvidenceViewer)
- 报告渲染器: Markdown → 浏览器内展示 (含图表嵌入)
- 成本 Dashboard: 实时 LLM + compute 消耗面板
- 科研 Closure Classifier: 判断任务是否需要 holdout / PI gate / more runs
```

## 5. 修改 Zero 的关键点 [O]

```text
- Memory create 默认 status 改为 draft, 不是 verified
- Role 定义: coordinator (系统提示含科研约束), worker (执行), reviewer (兼容性检查)
- Agent loop hook: 添加 Park/Resume gate + PI 审批 gate
- Closure decision: 扩展分类器, 增加 "needs_pi_approval" / "needs_holdout" 判断
- Runtime state: .zero workspace 状态 + shud-workspace 研究状态分离
```

## 6. 总结

```text
Built on Zero's proven agent runtime;
Extend with SHUD domain-specific capabilities.
One language, one repo, one team.
```
