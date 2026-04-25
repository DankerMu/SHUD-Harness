# Zero 扩展映射

**状态：** P0 设计规范  
**适用范围：** `zero` submodule、AgentLoop、tool registry、session、memory、WebSocket、skills  
**目标：** 明确哪些 Zero 能力复用，哪些需要覆盖，哪些必须禁用，哪些由 SHUD-Harness 新增。

## 1. 总体策略

Zero 作为 Agent runtime 基础设施使用；SHUD-Harness 不应复制 Zero 的通用 AgentLoop、session、tool streaming、Web 控制面板基础能力。SHUD-Harness 负责新增水文建模领域对象、科研治理、RunRecord、StackLock、DataProvenance、长任务 Park/Resume 和 PI gate。

建议将 Zero 作为 submodule 或 forked submodule 管理：

```text
submodules/zero/              # upstream/fork Zero runtime
packages/harness-core/        # SHUD-Harness 领域对象与 schema
packages/harness-agent/       # Zero adapter 与 Coordinator runtime
packages/harness-tools/       # SHUD/rSHUD/AutoSHUD 工具封装
apps/web/                     # Web scientific workbench
apps/server/                  # Hono/Bun API 与 WebSocket
```

## 2. 复用矩阵

| Zero 能力 | 处理方式 | SHUD-Harness 要求 |
|---|---|---|
| AgentLoop | 复用并加 hook | loop 前后注入 TaskCard、StackLock、RunRecord、PI gate |
| Session | 复用 | session 必须绑定 workspace 和 TaskCard |
| WebSocket 基础流 | 复用/适配 | 消息 envelope 按 `WebSocket_Protocol.md` 固定 |
| Tool registry | 复用 | 新增 `shud.*`、`rshud.*`、`autoshud.*`、`harness.*` 工具 |
| Bash/Sandbox tool | 覆盖 | 必须加入 workspace policy、资源限制、日志分片和命令审计 |
| Memory tool | 覆盖 | 禁止自动创建 verified evidence memory |
| Skills loader | 复用/扩展 | 加载 SHUD 领域 skill，支持版本锁 |
| Roles | 覆盖 | 改为 Coordinator/Worker/Coder/Reviewer/Memory Curator |
| Task closure | 覆盖 | 使用科研工程 closure 判据 |
| Web UI | 部分复用 | 升级为四栏 scientific workbench |

## 3. Adapter 边界

不建议直接在 Zero 内部到处写 SHUD 逻辑。推荐建立 adapter 层：

```ts
interface ZeroHarnessAdapter {
  buildSystemPrompt(input: HarnessAgentContext): string;
  beforeToolCall(call: ToolCall): Promise<ToolCallPolicyResult>;
  afterToolCall(result: ToolCallResult): Promise<void>;
  classifyClosure(state: TaskRuntimeState): Promise<ClosureDecision>;
  emitHarnessEvent(event: HarnessEvent): Promise<void>;
}
```

这样 Zero 的升级成本较低，SHUD-Harness 的科研规则也更集中。

## 4. 必须覆盖的 Zero 行为

### 4.1 Memory create

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

### 4.2 Bash/Sandbox

Zero 的通用 bash 工具需要加以下限制：

- cwd 必须在 workspace 内；
- 命令必须记录 digest；
- stdout/stderr 分片保存；
- 长命令转 RunJob；
- 删除 raw data、覆盖 baseline、修改 submodule 默认分支等操作必须被拦截；
- 所有命令结果写入 toolcall artifact。

### 4.3 Closure classifier

Zero 通用的“任务完成”判断不适合科研建模。SHUD-Harness closure 必须检查：

- TaskCard 状态；
- 是否有 RunRecord；
- 是否有 StackLock/DataProvenance；
- 是否有 deterministic metrics；
- 是否触发未处理 PI gate；
- EvidenceReport 是否包含 limitations 和 pi_questions。

## 5. 新增工具命名

建议工具命名空间如下：

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

工具输入输出必须使用 Zod schema，并在 WebSocket 中以 `tool.started`、`tool.stdout`、`tool.stderr`、`tool.completed`、`tool.failed` 推送。

## 6. Zero prompt 改造

System prompt 应注入四类信息：

1. **角色边界。** 当前 Agent 是 Coordinator、Worker、Coder 还是 Reviewer。
2. **科研治理。** 不得宣称科学结论；必须标注限制；PI gate 不可绕过。
3. **当前上下文。** TaskCard、StackLock、DataProvenance、最近 RunRecord、ResearchContext。
4. **工具策略。** 短任务直接执行；长任务转 RunJob；证据必须落盘。

## 7. Zero Web UI 改造

Zero 原有 Chat UI 可作为基础，但 v0.8 需要四栏：

```text
SideNav | AgentActivityFeed | ExperimentDashboard | ResultsPanel
```

Zero 的 streaming 能力应服务于 AgentActivityFeed 和 RuntimeTerminal，而不是只展示普通聊天消息。

## 8. Submodule 版本锁

StackLock 应记录 Zero 自身版本：

```yaml
zero:
  path: submodules/zero
  commit: abc123
  branch: shud-harness-v0.8
  dirty: false
  adapter_version: 0.8.0
  prompt_version: 0.8.0
  skill_versions:
    shud_runtime: 0.8.0
```

如果 Zero submodule dirty，系统应允许本地开发运行，但 EvidenceReport 必须标注 dirty state；benchmark 和 validated 报告默认不接受 dirty runtime。

## 9. 接入步骤

1. 建立 `packages/harness-agent`，实现 Zero adapter。
2. 把 Zero AgentLoop 的 event 输出转换为 Harness WebSocket envelope。
3. 覆盖 MemoryTool 和 SandboxTool。
4. 加入 Coordinator role prompt。
5. 实现 dummy tool 和 dummy RunJob。
6. 跑通 deterministic skeleton。
7. 再接入真实 SHUD/rSHUD/AutoSHUD 工具。

## 10. 验收标准

- [ ] Zero AgentLoop 能在 SHUD-Harness session 中运行。
- [ ] 所有 tool call 都带 `task_id`、`session_id`、`workspace_id`。
- [ ] MemoryTool 不会自动创建 verified evidence。
- [ ] SandboxTool 不允许 workspace 外写入。
- [ ] WebSocket 事件符合 `WebSocket_Protocol.md`。
- [ ] Closure 不由 Zero 默认 classifier 独立决定。
