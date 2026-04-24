# Z-01 ZeRo 当前实现基线（用于对照，不作为系统身份）

## 模块状态标签
- **独立实现**：仍然必须
- **ZeRo 参考实现**：强参考
- **[R] 已实现可复用**：runtime monorepo、agent loop、tools、scheduler、web、supervisor、roles、skills loader、memory store
- **[M] 需修改后复用**：bash sandbox 语义、memory 写入策略、角色名称与职责、Web IA
- **[N] 必须新增**：科研对象层与治理层

## 1. 这份文档的目的
本文件只回答一个问题：

> **到 2026-04-23 为止，ZeRo 当前到底已经实现了什么？**

回答这个问题，是为了后续明确：
- 哪些能力不需要从零写
- 哪些能力不能误以为已有
- 哪些地方必须重写，否则会把通用 agent runtime 误当科研系统

## 2. 仓库总览
ZeRo 当前公开仓库是一个 `Bun + TypeScript` monorepo，development 分支包含：
- `apps`
- `packages`
- `benchmarks`
- `docs`
- `prompts`
- `.claude`
- `.codex/environments`
- `README.md` / `README.zh-CN.md`  
仓库 README 直接把它定义为“persistent agent runtime with tools, memory, observability, scheduling, channel adapters, a Web control plane, and an optional supervisor process”。

## 3. 已存在的 runtime layers
根据 README，ZeRo 当前已有以下 runtime layers：
- `packages/shared`
- `packages/secrets`
- `packages/model`
- `packages/memory`
- `packages/observe`
- `packages/core`
- `packages/channel`
- `packages/scheduler`
- `packages/supervisor`
- `apps/*`

这说明 ZeRo 已经不是“提示词工程仓库”，而是一个成型的 runtime 基座。

## 4. 请求流 / 启动流
README 对 ZeRo 的 request flow 描述为：
1. 消息从 Web / Telegram / Feishu 进入
2. channel 归一化成共享 message types
3. `SessionManager` 绑定 session
4. agent 用 config / bootstrap / session history / memory 构造 prompt context
5. `ModelRouter` 选模型
6. tool loop 运行 read/write/bash/fetch/memory/schedule 等工具

这套流程非常适合被 SHUD-Harness 用作**通用请求与控制底座**。

## 5. ToolRegistry 与已注册工具
在 `apps/server/src/main.ts` 里，ZeRo 当前会注册：
- `ReadTool`
- `WriteTool`
- `EditTool`
- `BashTool`
- `FetchTool`
- `MemorySearchTool`
- `MemoryReadTool`
- `MemoryTool`
- `TaskTool`
- `ScheduleTool`
- `CodexTool`
- `SpawnAgentTool`
- `WaitAgentTool`
- `CloseAgentTool`
- `SendInputTool`

这意味着：
- 读写改查文件
- shell
- memory 检索/读取/写入
- schedule
- 子 agent 编排  
都已经有实现。

## 6. AgentLoop 当前的关键特征
`packages/core/src/agent/agent-loop.ts` 当前提供：
- `buildRequestUserContent`
- `onEndTurn`
- `processToolResults`
- `afterToolResults`
- `shouldInterrupt`
- `onEmptyResponse`
- 最大迭代控制
- tool_use / end_turn / empty response 的差异化处理

这说明 ZeRo 的核心不是“一问一答”，而是一个 hook 化的 loop kernel。

## 7. Task Closure 当前特征
`task-closure.ts` 当前把 closure decision 规范成：
- `finish`
- `continue`
- `block`

并且内置了研究/分析类任务的附加规则：
- 不能只给出第一轮总结就 finish
- 如果只分析了单一来源或仍有重要线索未验证，应该 continue

这给 SHUD-Harness 提供了非常接近科研 runtime 的收束控制思路。

## 8. Builtin Roles 当前特征
`roles.ts` 当前内置了：
- Explorer
- Coder
- Reviewer

对应默认工具大致是：
- Explorer：`read`, `bash`, `fetch`
- Coder：`read`, `write`, `edit`, `bash`, `codex`
- Reviewer：`read`, `bash`

这些角色仍是通用研发角色，不是 SHUD 科研角色，但结构上已经足够做 Commander / Worker / Critic 的映射。

## 9. BashTool 当前特征
`bash.ts` 当前已经有：
- 输入 `command`
- 可选 `description`
- 可选 `timeout`
- fuse list 检查
- 输出 shell result

这足够作为科研 sandbox 的内核工具，但仍缺少：
- episode-scoped workspace
- read-only raw data mount
- artifact auto-registration
- file diff trace
- job-aware orchestration

## 10. Skills Loader 当前特征
`packages/core/src/skill/loader.ts` 当前会从 `.zero/skills/` 加载技能。  
约定：
- 每个子目录包含 `SKILL.md`
- `SKILL.md` 带 YAML frontmatter
- 至少读出：
  - `name`
  - `description`
  - `allowed-tools`

这正适合作为 SHUD-Harness 的最小 skill ingestion 参考。

## 11. MemoryTool 当前特征
`packages/core/src/tool/memory.ts` 当前在 `create` 时会默认：
- `status: 'verified'`
- `confidence: 0.85`

这对科研系统来说是最大的现成风险之一，因为它默认允许 Agent 直接把判断写成 verified memory。

## 12. Web / Supervisor / Runtime State
ZeRo 当前已经有：
- Web control plane
- `.zero/heartbeat.json`
- optional supervisor restart loop
- `.zero` 下的 memory / config / logs / heartbeat 等 runtime 状态目录

这些都是 SHUD-Harness 可以直接借鉴的底座，但不能替代 `.shud-harness/` 与 `shud-workspace/` 的科研状态分离。

## 13. 总结：ZeRo 适合做什么，不适合直接替代什么
### 适合直接借的
- runtime skeleton
- tool registry
- session & trace
- skills loader
- role loading
- sub-agent orchestration
- scheduler
- supervisor
- web control plane

### 不能直接当成 SHUD-Harness 的
- scientific memory governance
- research object model
- data provenance
- StackLock / JobSpec / CalibrationSpec / BenchmarkPolicy
- operator-first research IA
- scientific gate system

## 14. 参考实现落点（便于代码定位）
- `README.md`
- `apps/server/src/main.ts`
- `packages/core/src/agent/agent-loop.ts`
- `packages/core/src/agent/task-closure.ts`
- `packages/core/src/agent/roles.ts`
- `packages/core/src/tool/bash.ts`
- `packages/core/src/tool/memory.ts`
- `packages/core/src/skill/loader.ts`
