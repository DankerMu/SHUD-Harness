# Zero OS 代码库现实报告

**日期**: 2026-04-24
**分支**: development (clean)
**语言**: TypeScript (Bun monorepo), ~11 packages + 3 apps
**仓库**: https://github.com/V1ki/zero
**SHUD 定制**: 无 (vanilla upstream)

## 1. 包结构

```
zero/
├── apps/
│   ├── server/     # CLI + 主 runtime 启动
│   ├── web/        # Hono + React 控制面板
│   └── supervisor/ # 心跳 + 自修复
├── packages/
│   ├── shared/     # 系统契约, 消息类型
│   ├── core/       # Agent loop, 工具, 会话, 技能, 任务
│   ├── memory/     # 持久化记忆 + 向量索引
│   ├── model/      # 模型路由 + Provider 适配器
│   ├── observe/    # 日志/指标/追踪/会话 DB
│   ├── channel/    # Web/Telegram/Feishu 消息适配
│   ├── scheduler/  # Cron 调度
│   ├── secrets/    # 加密保险箱 (macOS Keychain)
│   └── supervisor/ # 存活检测 + 修复引擎
├── docs/           # 架构文档
├── prompts/        # Prompt 模板
├── e2e/            # Playwright 测试
└── benchmarks/     # SubAgent 对比
```

## 2. 对 SHUD-Harness 最关键的组件

### 2.1 AgentLoop (`packages/core/src/agent/agent-loop.ts`)

```
AgentLoopConfig:
  adapter          — 模型 Provider
  toolExecutor     — 工具执行器
  system           — 系统 Prompt
  tools            — 工具定义列表
  maxIterations    — 最大迭代数
  stream           — 是否流式

Hooks (全部可自定义):
  buildRequestUserContent()  — 修改用户消息
  onEndTurn()                — 非工具响应后的 break/continue
  processToolResults()       — 工具结果后处理
  afterToolResults()         — 工具结果后的副作用
  shouldInterrupt()          — 提前中断信号
  onEmptyResponse()          — 空响应处理

主循环: while(hasIterations) → complete → tool_use? → executeTools → integrate → continue/break
```

### 2.2 已注册工具 (18 个)

| 工具 | 文件 | SHUD-Harness 对应 |
|------|------|-------------------|
| bash | bash.ts | → 科研 sandbox (需改造) |
| read | read.ts | → 可直接用 |
| write | write.ts | → 可直接用 |
| edit | edit.ts | → 可直接用 |
| fetch | fetch.ts | → 可直接用 |
| memory | memory.ts | → 必须改 (默认 verified=true) |
| memory_search | memory-search.ts | → 可用, 需调整检索策略 |
| memory_read | memory-read.ts | → 可直接用 |
| spawn_agent | spawn-agent.ts | → Commander→Worker/Critic |
| wait_agent | wait-agent.ts | → 可直接用 |
| close_agent | close-agent.ts | → 可直接用 |
| send_input | send-input.ts | → 可直接用 |
| task | task.ts | → 可借鉴 DAG 编排 |
| schedule | schedule.ts | → 可直接用 |
| codex | codex.ts | → 不需要 |

### 2.3 Roles (`packages/core/src/agent/roles.ts`)

内置角色 (需替换):
- **explorer**: read, bash, fetch → 保留或映射
- **coder**: read, write, edit, bash, codex → 替换为 **Worker**
- **reviewer**: read, bash → 替换为 **Critic**
- 需新增: **Commander**, **Harness Optimizer**

支持从 `.zero/roles/` 加载 TOML/YAML 自定义角色。

### 2.4 Task Closure (`packages/core/src/agent/task-closure.ts`)

分类器: finish / continue / block
- 对研究/分析类任务有附加规则: 不允许只给一轮总结就 finish
- 检查工具执行是否真的成功
- → 需改成科研特化 prompt

### 2.5 Skills Loader (`packages/core/src/skill/loader.ts`)

- 从 `.zero/skills/` 扫描子目录
- 每个技能必须有 `SKILL.md` + YAML frontmatter
- 解析: name, description, allowed-tools, content
- → 需增加: validator, lifecycle 管理, smoke test

### 2.6 Memory (`packages/memory/`)

- 文件存储: `.zero/memory/{type}/{id}.md` (YAML frontmatter + 正文)
- 类型: preference, decision, fact, context, history
- 向量索引: Vectra + Embedding (可选)
- **关键问题**: `memory.ts` 的 `create` 默认设 `status: verified, confidence: 0.85`
- → 必须改成 proposal-only

### 2.7 Web 控制面板 (`apps/web/`)

- Hono 服务器 + WebSocket
- React SPA: 会话、消息、配置、记忆浏览器
- → 需重构信息架构为 RCS/Experiment/Run/Evidence/Validation 导向

## 3. Prompt 系统

```
PromptMode: 'full' | 'minimal' | 'none'

full 模式包含:
  Role Block → Tool Rules → Memory Policy → Constraints →
  Rules → Output Style → Execution Mode → Safety →
  Tool Call Style → Skill Catalog → Identity → Runtime → Bootstrap

动态上下文通过 <system-reminder> 注入 (不进入缓存)
Bootstrap 文件: SOUL.md, USER.md, TOOLS.md (从 .zero/workspace/zero/ 加载)
```

## 4. 对 Harness 的复用矩阵摘要

| 能力 | 状态 | 行动 |
|------|------|------|
| Agent loop + hooks | [R] 可直接用 | 通过 hooks 接入 SHUD 语义 |
| 工具注册 | [R] 可直接用 | 无需改动 |
| Sub-agent 编排 | [R] 可直接用 | Commander→Worker/Critic 映射 |
| Session/trace | [R] 可直接用 | 保留 |
| Scheduler | [R] 可直接用 | 不等于 Executor |
| Supervisor | [R] 可直接用 | 心跳+修复 |
| Bash | [M] 需改造 | → 科研 sandbox |
| Roles | [M] 需改造 | → SHUD 角色 |
| Memory create | [M] 必须改 | → proposal-only |
| Skills loader | [M] 需改造 | → validator + lifecycle |
| Web IA | [M] 需改造 | → 科研对象导航 |
| Task closure | [M] 需改造 | → 科研特化 prompt |
| 科研对象层 | [N] 全新 | RCS/Experiment/Evidence/... |
| 版本锁 | [N] 全新 | StackLock/EnvLock |
| 数据溯源 | [N] 全新 | DatasetManifest/PreprocessRecipe |
| 基准治理 | [N] 全新 | BenchmarkPolicy/CalibrationSpec |
| Human Gate | [N] 全新 | 审批对象模型 |
