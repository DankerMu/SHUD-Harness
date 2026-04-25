# Zero 路线决策：基于 Zero 扩展，构建 SHUD 领域逻辑

> **注：** 第 7–13 节的实现级细节合并自 v0.8 设计附录 `Zero_Extension_Map.md`，覆盖 adapter 模式、工具命名、prompt 改造、接入步骤与验收标准。

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

---

## 7. 推荐 Monorepo 目录结构

Zero 作为根目录 submodule 管理（路径 `zero/`，与实际 repo 一致），SHUD-Harness 领域逻辑按 monorepo 分包组织：

```text
zero/                         # submodule, upstream/fork Zero runtime (只读参考)
packages/harness-core/        # SHUD-Harness 领域对象与 schema
packages/harness-agent/       # Zero adapter 与 Coordinator runtime
packages/harness-tools/       # SHUD/rSHUD/AutoSHUD 工具封装
apps/web/                     # Web scientific workbench
apps/server/                  # Hono/Bun API 与 WebSocket
```

> 路径体系的完整规则见 `03_SPEC/Workspace_Conventions.md` §1。

## 8. Adapter 层模式

不建议直接在 Zero 内部到处写 SHUD 逻辑。推荐建立 adapter 层，使 Zero 的升级成本较低，科研规则集中管理：

```ts
interface ZeroHarnessAdapter {
  buildSystemPrompt(input: HarnessAgentContext): string;
  beforeToolCall(call: ToolCall): Promise<ToolCallPolicyResult>;
  afterToolCall(result: ToolCallResult): Promise<void>;
  classifyClosure(state: TaskRuntimeState): Promise<ClosureDecision>;
  emitHarnessEvent(event: HarnessEvent): Promise<void>;
}
```

## 9. 必须覆盖的 Zero 行为（详细规范）

### 9.1 Memory create

Zero 若默认将记忆标为 `verified` 或较高 confidence，会与科研证据治理冲突。SHUD-Harness 中 memory 写入必须分级：

```yaml
memory_candidate:
  type: preference | project_fact | stack_fact | evidence_summary | pi_decision
  verification_status: candidate | pi_confirmed | deprecated
  confidence: null
  evidence_refs:
    - report: REPORT-...
```

`evidence_summary` 不允许自动变为 `pi_confirmed`。只有用户明确确认或通过审批流程后才能升级。

### 9.2 Bash/Sandbox

Zero 的通用 bash 工具需要加以下限制：

- cwd 必须在 workspace 内；
- 命令必须记录 digest；
- stdout/stderr 分片保存；
- 长命令转 RunJob；
- 删除 raw data、覆盖 baseline、修改 submodule 默认分支等操作必须被拦截；
- 所有命令结果写入 toolcall artifact。

### 9.3 Closure classifier

Zero 通用的"任务完成"判断不适合科研建模。SHUD-Harness closure 必须检查：

- TaskCard 状态；
- 是否有 RunRecord；
- 是否有 StackLock/DataProvenance；
- 是否有 deterministic metrics；
- 是否触发未处理 PI gate；
- EvidenceReport 是否包含 limitations 和 pi_questions。

## 10. 新增工具命名空间

工具按领域分命名空间，输入输出必须使用 Zod schema，并在 WebSocket 中以 `tool.started`、`tool.stdout`、`tool.stderr`、`tool.completed`、`tool.failed` 推送：

```text
harness.task.create
harness.stack.lock
harness.data.register
harness.job.submit
harness.job.collect
harness.runrecord.write
harness.report.generate
harness.change_request.create
shud.build
shud.run
shud.scan_outputs
rshud.read_output
rshud.compute_metrics
autoshud.run_step
sandbox.exec
```

## 11. Zero Prompt 改造

System prompt 应注入四类信息：

1. **角色边界。** 当前 Agent 是 Coordinator、Worker、Coder 还是 Reviewer。
2. **科研治理。** 不得宣称科学结论；必须标注限制；PI gate 不可绕过。
3. **当前上下文。** TaskCard、StackLock、DataProvenance、最近 RunRecord、ResearchContext。
4. **工具策略。** 短任务直接执行；长任务转 RunJob；证据必须落盘。

## 12. Zero Web UI 改造

Zero 原有 Chat UI 可作为基础，但 v0.8 需要四栏布局：

```text
SideNav | AgentActivityFeed | ExperimentDashboard | ResultsPanel
```

Zero 的 streaming 能力应服务于 AgentActivityFeed 和 RuntimeTerminal，而不是只展示普通聊天消息。

## 13. Submodule 版本锁

StackLock 应记录 Zero 自身版本：

```yaml
zero:
  path: zero
  commit: abc123
  branch: shud-harness-v0.8
  dirty: false
  adapter_version: 0.8.0
  prompt_version: 0.8.0
  skill_versions:
    shud_runtime: 0.8.0
```

如果 Zero submodule dirty，系统应允许本地开发运行，但 EvidenceReport 必须标注 dirty state；benchmark 和 validated 报告默认不接受 dirty runtime。

## 14. 接入步骤

1. 建立 `packages/harness-agent`，实现 Zero adapter。
2. 把 Zero AgentLoop 的 event 输出转换为 Harness WebSocket envelope。
3. 覆盖 MemoryTool 和 SandboxTool。
4. 加入 Coordinator role prompt。
5. 实现 dummy tool 和 dummy RunJob。
6. 跑通 deterministic skeleton。
7. 再接入真实 SHUD/rSHUD/AutoSHUD 工具。

## 15. 验收标准

- [ ] Zero AgentLoop 能在 SHUD-Harness session 中运行。
- [ ] 所有 tool call 都带 `task_id`、`session_id`、`workspace_id`。
- [ ] MemoryTool 不会自动创建 verified evidence。
- [ ] SandboxTool 不允许 workspace 外写入。
- [ ] WebSocket 事件符合 `WebSocket_Protocol.md`。
- [ ] Closure 不由 Zero 默认 classifier 独立决定。
